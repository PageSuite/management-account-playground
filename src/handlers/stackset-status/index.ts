import { EventBridgeEvent } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand, UpdateCommandInput } from '@aws-sdk/lib-dynamodb';
import { OrganizationsClient, DescribeAccountCommand } from '@aws-sdk/client-organizations';

// Initialize DynamoDB client
const dynamoDbClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const dynamoDbDocClient = DynamoDBDocumentClient.from(dynamoDbClient);

// Initialize Organizations client
const orgClient = new OrganizationsClient({ region: process.env.AWS_REGION });

const TABLE_NAME = process.env.TABLE_NAME!;

export const handler = async (event: EventBridgeEvent<string, unknown>): Promise<void> => {
    console.log('Event received:', JSON.stringify(event, null, 2));

    const eventDetail = event.detail as Record<string, unknown>;

    if (event.source === 'aws.cloudformation' && event['detail-type'] === 'CloudFormation StackSet StackInstance Status Change') {
        console.log('CloudFormation: StackSet instance status change');
        await handleStackSetInstanceStatusChange(eventDetail);
    } else {
        console.log(`Unexpected event: source=${event.source}, detail-type=${event['detail-type']}`);
    }
};

async function handleStackSetInstanceStatusChange(eventDetail: Record<string, unknown>): Promise<void> {
    try {
        // Extract stack-id and status from event
        const stackId = eventDetail['stack-id'] as string || '';
        const statusDetails = eventDetail['status-details'] as Record<string, unknown> || {};
        
        // Extract account ID from stack-id (format: arn:aws:cloudformation:region:ACCOUNT_ID:stack/...)
        const stackIdParts = stackId.split(':');
        if (stackIdParts.length < 5) {
            console.error(`Invalid stack-id format: ${stackId}`);
            return;
        }
        const accountId = stackIdParts[4];
        
        // Get status (prefer detailed-status if available)
        const stackSetStatus = (statusDetails['detailed-status'] || statusDetails['status']) as string || '';
        
        // Get account name from Organizations
        const { Account } = await orgClient.send(new DescribeAccountCommand({
            AccountId: accountId
        }));
        
        if (!Account || !Account.Name) {
            console.error(`Could not retrieve account name for account ID: ${accountId}`);
            return;
        }
        
        // Scan the DynamoDB table for items where AwsAccountName matches
        const scanParams = {
            TableName: TABLE_NAME,
            FilterExpression: 'AwsAccountName = :accountName',
            ExpressionAttributeValues: {
                ':accountName': Account.Name
            }
        };
        
        const results = await dynamoDbDocClient.send(new ScanCommand(scanParams));
        
        if (!results.Items || results.Items.length === 0) {
            console.log(`No DynamoDB item found for account name: ${Account.Name} (${accountId})`);
            return;
        }
        
        // Enforce single item processing
        if (results.Items.length > 1) {
            console.error(`ERROR: Found ${results.Items.length} items for account name ${Account.Name}, expected exactly 1`);
            return;
        }
        
        const item = results.Items[0];
        
        // Map StackSet status to our status (only SUCCEEDED -> READY, rest as-is)
        const roleStatus = stackSetStatus === 'SUCCEEDED' ? 'READY' : stackSetStatus;
        
        // Check if update is needed (avoid unnecessary writes)
        if (roleStatus === 'READY' && item.PageSuiteRoleStatus === 'READY' && item.PageSuiteRoleArn) {
            console.log(`PageSuiteRole already deployed for ${item.PK} ${item.SK}, skipping update`);
            return;
        }
        
        // Build update parameters
        let updateExpression = 'SET PageSuiteRoleStatus = :roleStatus, LastModified = :lastModified';
        let expressionAttributeValues: Record<string, any> = {
            ':roleStatus': roleStatus,
            ':lastModified': new Date().toISOString()
        };
        
        // Only set ARN when status is READY
        if (roleStatus === 'READY') {
            updateExpression = 'SET PageSuiteRoleArn = :roleArn, PageSuiteRoleStatus = :roleStatus, LastModified = :lastModified';
            expressionAttributeValues[':roleArn'] = `arn:aws:iam::${accountId}:role/PageSuiteRole`;
        }
        
        const updateParams: UpdateCommandInput = {
            TableName: TABLE_NAME,
            Key: {
                PK: item.PK,
                SK: item.SK
            },
            UpdateExpression: updateExpression,
            ExpressionAttributeValues: expressionAttributeValues
        };
        
        await dynamoDbDocClient.send(new UpdateCommand(updateParams));
        console.log(`Updated DynamoDB for ${item.PK} ${item.SK} with PageSuiteRole status: ${roleStatus}`);
        
        console.log(`StackSet instance status processed:`, {
            accountId,
            accountName: Account.Name,
            stackSetStatus,
            roleStatus
        });
        
    } catch (error) {
        console.error('Error handling StackSet instance status change:', error);
    }
}