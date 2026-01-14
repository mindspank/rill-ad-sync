/**
 * Cloud Function entry point for AD to Rill user sync
 */

import { Request, Response } from '@google-cloud/functions-framework';
import { AdClient } from './adClient';
import { RillClient } from './rillClient';
import { EnvConfig, SyncResult } from './types';
import * as logger from './logger';

/**
 * Validate and load environment variables
 */
function getEnvConfig(): EnvConfig {
  const requiredVars = [
    'AD_TENANT_ID',
    'AD_CLIENT_ID',
    'AD_CLIENT_SECRET',
    'AD_GROUP_NAME',
    'RILL_API_TOKEN',
    'RILL_GROUP_NAME',
  ];

  const missing = requiredVars.filter(
    (varName) => !process.env[varName] || process.env[varName]!.trim().length === 0
  );

  if (missing.length > 0) {
    throw new Error(
      `Missing or empty required environment variables: ${missing.join(', ')}`
    );
  }

  const config = {
    adTenantId: process.env.AD_TENANT_ID!.trim(),
    adClientId: process.env.AD_CLIENT_ID!.trim(),
    adClientSecret: process.env.AD_CLIENT_SECRET!.trim(),
    adGroupName: process.env.AD_GROUP_NAME!.trim(),
    rillApiToken: process.env.RILL_API_TOKEN!.trim(),
    rillGroupName: process.env.RILL_GROUP_NAME!.trim(),
    rillOrgName: process.env.RILL_ORG_NAME?.trim(),
  };

  // Validate that critical values are not just whitespace
  if (!config.adTenantId || !config.adClientId || !config.adClientSecret) {
    throw new Error('AD credentials cannot be empty');
  }
  if (!config.rillApiToken) {
    throw new Error('RILL_API_TOKEN cannot be empty');
  }

  return config;
}

/**
 * Perform the sync operation
 */
async function performSync(config: EnvConfig): Promise<SyncResult> {
  const result: SyncResult = {
    success: true,
    usersCreated: 0,
    usersAddedToGroup: 0,
    errors: [],
  };

  const syncStartTime = Date.now();
  try {
    // Initialize clients
    const adClient = new AdClient(
      config.adTenantId,
      config.adClientId,
      config.adClientSecret
    );
    const rillClient = new RillClient(
      config.rillApiToken,
      config.rillOrgName
    );

    // Check if Rill CLI is available
    const rillCliAvailable = await rillClient.checkRillCliAvailable();
    if (!rillCliAvailable) {
      throw new Error('Rill CLI is not available. Please ensure it is installed.');
    }

    // Fetch users from AD group
    logger.logInfo('Fetching users from AD group', { adGroupName: config.adGroupName });
    const adUsers = await adClient.getUsersInGroup(config.adGroupName);
    logger.logInfo('Found users in AD group', { count: adUsers.length });

    // Validate group size to prevent timeouts
    const MAX_GROUP_SIZE = 10000;
    if (adUsers.length > MAX_GROUP_SIZE) {
      throw new Error(
        `AD group has ${adUsers.length} users, which exceeds the maximum of ${MAX_GROUP_SIZE}. ` +
        `This sync would likely timeout. Please split into smaller groups.`
      );
    }

    // Normalize AD users to lowercase for consistent comparison
    const normalizedAdUsers = adUsers.map((email) => email.toLowerCase().trim());

    // Fetch users from Rill group
    logger.logInfo('Fetching users from Rill group', { rillGroupName: config.rillGroupName });
    let rillGroupUsers: string[] = [];
    try {
      rillGroupUsers = await rillClient.listGroupMembers(config.rillGroupName);
      logger.logInfo('Found users in Rill group', { count: rillGroupUsers.length });
    } catch (error: any) {
      // If group doesn't exist, that's a critical error
      if (error.message && error.message.includes('does not exist')) {
        throw new Error(
          `Rill group "${config.rillGroupName}" does not exist. Please create it first.`
        );
      }
      throw error;
    }

    // Use Set for O(1) lookups instead of O(n) includes()
    const rillGroupUsersSet = new Set(rillGroupUsers.map((email) => email.toLowerCase().trim()));

    // Find users in AD but not in Rill group (these need to be created and added)
    const usersToCreate = normalizedAdUsers.filter(
      (email) => !rillGroupUsersSet.has(email)
    );

    // Find users that are in Rill but not in the group (these just need to be added)
    // Note: We can't easily determine this without listing all Rill users,
    // so we'll try to add all AD users and let Rill CLI handle "already in group" gracefully
    const usersToAddToGroup = normalizedAdUsers;

    // Create new users in Rill with rate limiting (sequential to avoid overwhelming the API)
    logger.logInfo('Creating new users in Rill', { count: usersToCreate.length });
    const createStartTime = Date.now();
    for (let i = 0; i < usersToCreate.length; i++) {
      const email = usersToCreate[i];
      try {
        await rillClient.createUser(email, 'viewer');
        result.usersCreated++;
        logger.logInfo('Created user', { 
          email, 
          progress: `${i + 1}/${usersToCreate.length}` 
        });
      } catch (error) {
        const errorMsg = `Failed to create user ${email}: ${error instanceof Error ? error.message : 'Unknown error'}`;
        logger.logError('Failed to create user', error, { 
          email, 
          progress: `${i + 1}/${usersToCreate.length}` 
        });
        result.errors.push(errorMsg);
        // Don't mark as failure if it's just "already exists" - that's expected
        if (!errorMsg.includes('already exists')) {
          result.success = false;
        }
        // Continue with other users even if one fails
      }
      // Small delay to avoid rate limiting (50ms between requests)
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const createDuration = ((Date.now() - createStartTime) / 1000).toFixed(1);
    logger.logInfo('User creation completed', { duration: `${createDuration}s` });

    // Add all AD users to the Rill group (idempotent operation) with rate limiting
    logger.logInfo('Adding users to Rill group', { 
      count: normalizedAdUsers.length,
      rillGroupName: config.rillGroupName 
    });
    const addStartTime = Date.now();
    for (let i = 0; i < normalizedAdUsers.length; i++) {
      const email = normalizedAdUsers[i];
      try {
        await rillClient.addUserToGroup(email, config.rillGroupName);
        // Only count if it was a new addition (not already in group)
        if (!rillGroupUsersSet.has(email)) {
          result.usersAddedToGroup++;
          logger.logInfo('Added user to group', { 
            email, 
            progress: `${i + 1}/${normalizedAdUsers.length}` 
          });
        } else {
          // Only log every 10th user to reduce log noise for large groups
          if ((i + 1) % 10 === 0 || normalizedAdUsers.length < 20) {
            logger.logDebug('User already in group, skipped', { 
              email, 
              progress: `${i + 1}/${normalizedAdUsers.length}` 
            });
          }
        }
      } catch (error) {
        const errorMsg = `Failed to add user ${email} to group: ${error instanceof Error ? error.message : 'Unknown error'}`;
        logger.logError('Failed to add user to group', error, { 
          email, 
          progress: `${i + 1}/${normalizedAdUsers.length}` 
        });
        result.errors.push(errorMsg);
        // Don't mark as failure if it's just "already" - that's expected
        if (!errorMsg.includes('already')) {
          result.success = false;
        }
        // Continue with other users even if one fails
      }
      // Small delay to avoid rate limiting (50ms between requests)
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const addDuration = ((Date.now() - addStartTime) / 1000).toFixed(1);
    logger.logInfo('Group addition completed', { duration: `${addDuration}s` });

    const totalDuration = ((Date.now() - syncStartTime) / 1000).toFixed(1);
    logger.logInfo('Sync completed', {
      duration: `${totalDuration}s`,
      usersCreated: result.usersCreated,
      usersAddedToGroup: result.usersAddedToGroup,
      errorCount: result.errors.length,
    });
    
    if (result.errors.length > 0) {
      logger.logWarning('Sync completed with errors', {
        errorCount: result.errors.length,
        errors: result.errors.slice(0, 5), // Log first 5 errors
      });
    }
    // Consider it successful if we made progress, even if some operations failed
    if (result.usersCreated > 0 || result.usersAddedToGroup > 0) {
      result.success = true;
    }

    return result;
  } catch (error) {
    const errorMsg = `Sync failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
    logger.logError('Sync failed', error, {
      usersCreated: result.usersCreated,
      usersAddedToGroup: result.usersAddedToGroup,
    });
    result.success = false;
    result.errors.push(errorMsg);
    return result;
  }
}

/**
 * Cloud Function HTTP handler
 */
export async function syncUsers(req: Request, res: Response): Promise<void> {
  logger.logInfo('Sync function triggered', {
    method: req.method,
    path: req.path,
  });

  try {
    // Validate environment variables
    const config = getEnvConfig();

    // Perform sync
    const result = await performSync(config);

    // Return result
    if (result.success) {
      res.status(200).json({
        success: true,
        message: 'Sync completed successfully',
        usersCreated: result.usersCreated,
        usersAddedToGroup: result.usersAddedToGroup,
        errors: result.errors,
      });
    } else {
      res.status(500).json({
        success: false,
        message: 'Sync completed with errors',
        usersCreated: result.usersCreated,
        usersAddedToGroup: result.usersAddedToGroup,
        errors: result.errors,
      });
    }
  } catch (error) {
    logger.logError('Function error', error);
    res.status(500).json({
      success: false,
      message: 'Sync failed',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}
