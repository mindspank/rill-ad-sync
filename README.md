# AD to Rill User Sync

A Google Cloud Function (2nd gen) that synchronizes users from an Azure Active Directory (Microsoft Entra ID) group to a Rill group.

## Overview

This utility automatically:
1. Fetches users from a specified Azure AD group
2. Creates users in Rill (with viewer role) if they don't exist
3. Ensures all AD users are members of the specified Rill group

## Prerequisites

- Google Cloud Platform account with billing enabled
- Azure AD (Microsoft Entra ID) with:
  - Service Principal (App Registration) with client credentials
  - API permission: `GroupMember.Read.All` (Application permission)
- Rill account with:
  - Personal Access Token (PAT)
  - Organization and group already created

## Environment Variables

The following environment variables must be set when deploying the function:

### Required Variables

- `AD_TENANT_ID` - Azure AD (Microsoft Entra ID) tenant ID
- `AD_CLIENT_ID` - Azure AD service principal client ID (App Registration)
- `AD_CLIENT_SECRET` - Azure AD service principal client secret
- `AD_GROUP_NAME` - Display name of Azure AD group to sync from
- `RILL_API_TOKEN` - Rill personal access token
- `RILL_GROUP_NAME` - Name of Rill group to sync to

### Optional Variables

- `RILL_ORG_NAME` - Rill organization name (if required by CLI)

## Local Development

### Setup

1. Install dependencies:
```bash
npm install
```

2. Set environment variables (create a `.env` file or export them):
```bash
export AD_TENANT_ID="your-tenant-id"
export AD_CLIENT_ID="your-client-id"
export AD_CLIENT_SECRET="your-client-secret"
export AD_GROUP_NAME="Your AD Group Name"
export RILL_API_TOKEN="your-rill-token"
export RILL_GROUP_NAME="your-rill-group"
```

3. Build the project:
```bash
npm run build
```

### Testing Locally

You can test the function locally using the Functions Framework:

```bash
npx @google-cloud/functions-framework --target=syncUsers --port=8080
```

Then trigger it with:
```bash
curl -X POST http://localhost:8080
```

## Deployment

### Deploy to Google Cloud Functions (2nd gen)

1. Ensure you have the Google Cloud SDK installed and authenticated:
```bash
gcloud auth login
gcloud config set project YOUR_PROJECT_ID
```

2. Enable required APIs:
```bash
gcloud services enable cloudfunctions.googleapis.com
gcloud services enable cloudbuild.googleapis.com
gcloud services enable run.googleapis.com
gcloud services enable artifactregistry.googleapis.com
```

3. Deploy the function:

**Using environment variables directly:**
```bash
gcloud functions deploy ad-sync \
  --gen2 \
  --runtime nodejs20 \
  --trigger-http \
  --allow-unauthenticated \
  --entry-point syncUsers \
  --source . \
  --region us-central1 \
  --set-env-vars AD_TENANT_ID=your-tenant-id,AD_CLIENT_ID=your-client-id,AD_GROUP_NAME=Your\ AD\ Group,RILL_API_TOKEN=your-token,RILL_GROUP_NAME=your-rill-group
```

**Using Secret Manager (Recommended for sensitive values):**

First, create secrets in Secret Manager:
```bash
echo -n "your-client-secret" | gcloud secrets create ad-client-secret --data-file=-
echo -n "your-rill-token" | gcloud secrets create rill-api-token --data-file=-
```

Then deploy with secrets:
```bash
gcloud functions deploy ad-sync \
  --gen2 \
  --runtime nodejs20 \
  --trigger-http \
  --allow-unauthenticated \
  --entry-point syncUsers \
  --source . \
  --region us-central1 \
  --set-env-vars AD_TENANT_ID=your-tenant-id,AD_CLIENT_ID=your-client-id,AD_GROUP_NAME=Your\ AD\ Group,RILL_GROUP_NAME=your-rill-group \
  --set-secrets AD_CLIENT_SECRET=ad-client-secret:latest,RILL_API_TOKEN=rill-api-token:latest
```

4. Note the function URL from the deployment output. You'll need this for Cloud Scheduler.

### Set Up Cloud Scheduler

Create a Cloud Scheduler job to trigger the function on a schedule:

```bash
gcloud scheduler jobs create http ad-sync-job \
  --location=us-central1 \
  --schedule="0 * * * *" \
  --uri="https://REGION-PROJECT_ID.cloudfunctions.net/ad-sync" \
  --http-method=POST \
  --oidc-service-account-email=PROJECT_NUMBER-compute@developer.gserviceaccount.com
```

Replace:
- `REGION` with your function region (e.g., `us-central1`)
- `PROJECT_ID` with your GCP project ID
- `PROJECT_NUMBER` with your GCP project number

### Permissions

Ensure the Cloud Scheduler service account has permission to invoke the function:

```bash
gcloud functions add-iam-policy-binding ad-sync \
  --region=us-central1 \
  --member=serviceAccount:PROJECT_NUMBER-compute@developer.gserviceaccount.com \
  --role=roles/cloudfunctions.invoker
```

## How It Works

1. **Authentication**: The function authenticates with Azure AD using service principal credentials (client credentials flow).

2. **Fetch AD Users**: Retrieves all users from the specified Azure AD group using Microsoft Graph API.

3. **Fetch Rill Users**: Lists all users currently in the specified Rill group using Rill CLI.

4. **Sync Logic**:
   - For users in AD but not in Rill: Creates them with the "viewer" role
   - For all AD users: Ensures they are members of the Rill group (idempotent operation)

5. **Error Handling**: The function continues processing even if individual operations fail, logging errors for review.

## Azure AD Setup

### Create Service Principal

1. Go to Azure Portal → Azure Active Directory → App registrations
2. Click "New registration"
3. Register the application (note the Application (client) ID and Directory (tenant) ID)
4. Go to "Certificates & secrets" → Create a new client secret
5. Go to "API permissions" → Add permission → Microsoft Graph → Application permissions
6. Add `GroupMember.Read.All` permission
7. Click "Grant admin consent"

## Rill Setup

1. Generate a Personal Access Token in Rill:
   - Go to your Rill account settings
   - Create a new token with appropriate permissions
   - Save the token securely

2. Ensure the target group exists in Rill (the function will not create groups)

## Troubleshooting

### Function fails to deploy

- Check that all required APIs are enabled
- Verify your GCP project has billing enabled
- Check build logs: `gcloud builds list`

### Function returns 500 errors

- Check Cloud Functions logs: `gcloud functions logs read ad-sync --region=us-central1`
- Verify all environment variables are set correctly
- Ensure Azure AD service principal has correct permissions
- Verify Rill API token is valid

### Rill CLI not found

- The Rill CLI is installed automatically during build via the postinstall script
- If installation fails, you may need to create a Dockerfile to install it manually
- Check build logs for installation errors

### Users not syncing

- Verify the AD group name matches exactly (case-sensitive)
- Check that the Rill group exists
- Review function logs for specific error messages
- Ensure Azure AD service principal has `GroupMember.Read.All` permission

## Architecture

- **Language**: TypeScript/Node.js
- **Runtime**: Node.js 20
- **Deployment**: Google Cloud Functions (2nd gen) with buildpacks
- **Authentication**: Azure AD service principal (client credentials)
- **APIs**: Microsoft Graph API, Rill CLI

## License

ISC
