import { EventBridgeEvent } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand, UpdateCommandInput } from '@aws-sdk/lib-dynamodb';

// Initialize DynamoDB client
const dynamoDbClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const dynamoDbDocClient = DynamoDBDocumentClient.from(dynamoDbClient);

const TABLE_NAME = process.env.TABLE_NAME!;

export const handler = async (event: EventBridgeEvent<string, unknown>): Promise<void> => {
    console.log('Event received:', JSON.stringify(event, null, 2));

    const eventDetail = event.detail as Record<string, unknown>;

    if (event.source === 'aws.controltower' && eventDetail.eventName === 'CreateManagedAccount') {
        console.log('Control Tower: Account creation completed');
        await handleCreateManagedAccount(eventDetail);
    } else {
        console.log(`Unexpected event: source=${event.source}, eventName=${eventDetail.eventName}`);
    }
};

async function handleCreateManagedAccount(eventDetail: Record<string, unknown>): Promise<void> {
    try {
        // Extract service event details
        const serviceEventDetails = eventDetail.serviceEventDetails as Record<string, unknown> || {};
        const createManagedAccountStatus = serviceEventDetails.createManagedAccountStatus as Record<string, unknown> || {};
        const account = createManagedAccountStatus.account as Record<string, unknown> || {};

        // Extract the values we need to update
        const state = createManagedAccountStatus.state as string || '';
        const awsAccountId = account.accountId as string || '';
        const accountName = account.accountName as string || '';

        // Remap SUCCEEDED to READY
        const awsAccountStatus = state === 'SUCCEEDED' ? 'READY' : state;

        // Implement DynamoDB scan to find and update the matching item
        // Since Control Tower events don't include the original Service Catalog tags,
        // we need to match using the Account Name that was stored during ProvisionProduct.

        // Scan the DynamoDB table for items where AwsAccountName matches
        const scanParams = {
            TableName: TABLE_NAME,
            FilterExpression: 'AwsAccountName = :accountName',
            ExpressionAttributeValues: {
                ':accountName': accountName
            }
        };

        const results = await dynamoDbDocClient.send(new ScanCommand(scanParams));

        if (!results.Items || results.Items.length === 0) {
            console.error(`No DynamoDB item found for account name: ${accountName}`);
            return;
        }

        // Enforce single item processing
        if (results.Items.length > 1) {
            console.error(`ERROR: Found ${results.Items.length} items for account name ${accountName}, expected exactly 1`);
            return;
        }

        const item = results.Items[0];

        // Update the item with the AWS account ID and status
        const updateParams: UpdateCommandInput = {
            TableName: TABLE_NAME,
            Key: {
                PK: item.PK,
                SK: item.SK
            },
            UpdateExpression: 'SET AwsAccountId = :awsAccountId, AwsAccountStatus = :status, LastModified = :lastModified',
            ExpressionAttributeValues: {
                ':awsAccountId': awsAccountId,
                ':status': awsAccountStatus,
                ':lastModified': new Date().toISOString()
            }
        };

        await dynamoDbDocClient.send(new UpdateCommand(updateParams));
        console.log(`Updated DynamoDB for ${item.PK} ${item.SK} with AWS Account ID: ${awsAccountId}, status: ${awsAccountStatus}`);

        console.log(`Control Tower account creation processed:`, {
            awsAccountId,
            awsAccountStatus,
            accountName
        });

    } catch (error) {
        console.error('Error handling CreateManagedAccount event:', error);
    }
}