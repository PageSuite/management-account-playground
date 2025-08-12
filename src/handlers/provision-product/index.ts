import { EventBridgeEvent } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand, UpdateCommandInput } from '@aws-sdk/lib-dynamodb';

// Initialize DynamoDB client
const dynamoDbClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const dynamoDbDocClient = DynamoDBDocumentClient.from(dynamoDbClient);

const TABLE_NAME = process.env.TABLE_NAME!;

export const handler = async (event: EventBridgeEvent<string, unknown>): Promise<void> => {
    console.log('Event received:', JSON.stringify(event, null, 2));

    const eventDetail = event.detail as Record<string, unknown>;
    
    if (event.source === 'aws.servicecatalog' && eventDetail.eventName === 'ProvisionProduct') {
        console.log('Service Catalog: Product provisioning started');
        await handleProvisionProduct(eventDetail);
    } else {
        console.log(`Unexpected event: source=${event.source}, eventName=${eventDetail.eventName}`);
    }
};

async function handleProvisionProduct(eventDetail: Record<string, unknown>): Promise<void> {
    try {
        // Extract request parameters and response elements
        const requestParameters = eventDetail.requestParameters as Record<string, unknown> || {};
        const responseElements = eventDetail.responseElements as Record<string, unknown> || {};
        const recordDetail = responseElements.recordDetail as Record<string, unknown> || {};
        
        // Extract tags to get PageSuite account ID and environment
        const tags = requestParameters.tags as Array<{key: string, value: string}> || [];
        console.log('Tags found:', JSON.stringify(tags));
        
        const psAccountId = tags.find(t => t.key === 'ps:accountId')?.value;
        const environment = tags.find(t => t.key === 'ps:environment')?.value;
        
        console.log('Extracted ps:accountId:', psAccountId);
        console.log('Extracted ps:environment:', environment);
        
        if (!psAccountId || !environment) {
            console.error('Missing required tags: ps:accountId or ps:environment');
            console.error('requestParameters:', JSON.stringify(requestParameters));
            return;
        }
        
        // Extract AccountName from provisioningParameters
        const provisioningParameters = requestParameters.provisioningParameters as Array<{key: string, value: string}> || [];
        const accountName = provisioningParameters.find(p => p.key === 'AccountName')?.value || '';
        
        // Extract provisioning status
        const rawStatus = recordDetail.status as string || 'UNKNOWN';
        
        // Remap status: CREATED -> IN_PROGRESS (since CREATED just means Service Catalog created the product)
        let status: string;
        if (rawStatus === 'CREATED') {
            status = 'IN_PROGRESS';
        } else {
            status = rawStatus;
        }
        
        // Update DynamoDB item
        const updateParams: UpdateCommandInput = {
            TableName: TABLE_NAME,
            Key: {
                PK: `PS#${psAccountId}`,
                SK: `ENV#${environment}`
            },
            UpdateExpression: 'SET AwsAccountStatus = :status, AwsAccountName = :accountName, LastModified = :lastModified',
            ExpressionAttributeValues: {
                ':status': status,
                ':accountName': accountName,
                ':lastModified': new Date().toISOString()
            }
        };
        
        await dynamoDbDocClient.send(new UpdateCommand(updateParams));
        console.log(`Updated DynamoDB for PS#${psAccountId} ENV#${environment} with status: ${status}, accountName: ${accountName}`);
        
    } catch (error) {
        console.error('Error handling ProvisionProduct event:', error);
    }
}