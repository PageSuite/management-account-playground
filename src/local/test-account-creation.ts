import { ServiceCatalogClient, ProvisionProductCommand, ProvisionProductCommandInput, ListProvisioningArtifactsCommand, ListProvisioningArtifactsCommandInput } from "@aws-sdk/client-service-catalog";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, PutCommandInput } from "@aws-sdk/lib-dynamodb";
import { fromSSO } from '@aws-sdk/credential-providers';
import { v4 as uuidv4 } from 'uuid';

// STATIC VALUES
const ACCOUNT_FACTORY_PRODUCT_ID = "prod-6f6q5myc3kzmy" as const; // Your specific product ID - immutable

// TYPE DEFINITIONS
type Environment = "Prod" | "UAT" | "Dev";

// INPUT VALUES
const PAGESUITE_ACCOUNT_ID = uuidv4(); // Dynamically generate a new UUID v4 for testing purposes
const ENVIRONMENT: Environment = "Dev"

// CLIENTS/SERVICES
const serviceCatalogClient = new ServiceCatalogClient({ 
    region: "eu-west-1",
    credentials: fromSSO({ profile: 'management' })
});
const dynamoDbClient = new DynamoDBClient({ 
    region: "eu-west-1",
    credentials: fromSSO({ profile: 'management' })
});
const dynamoDbDocClient = DynamoDBDocumentClient.from(dynamoDbClient);

async function main(): Promise<void> {
    console.log(`Creating account with PageSuite Account ID: ${PAGESUITE_ACCOUNT_ID}`);
    
    // 1. Create our initial 'link' entry in DynamoDB
    const cmdInput: PutCommandInput = {
        TableName: "ManagementAccountPlaygroundStack-LinkTableD22F4F47-19OHN1D6WHD42",
        Item: {
            PK: `PS#${PAGESUITE_ACCOUNT_ID}`,
            SK: `ENV#${ENVIRONMENT}`,
            AwsAccountStatus: 'PENDING',
            AwsAccountId: '',
            AwsAccountName: '',
            PageSuiteRoleStatus: 'PENDING',
            PageSuiteRoleArn: '',
            LastModified: new Date().toISOString(),
        },
        ConditionExpression: 'attribute_not_exists(PK) AND attribute_not_exists(SK)'
    };

    await dynamoDbDocClient.send(new PutCommand(cmdInput));

    // 2. Work out what organisational unit (OU) we need to use
    const organizationalUnit = getOrganizationalUnitForEnvironment(ENVIRONMENT);

    // 3. Work out what the latest active provisioning artifact ID is
    const artifactId = await getLatestActiveArtifactId();

    // 3. Provision a new account via Service
    const newAccount = await requestAwsAccount({
        product: {
            id: ACCOUNT_FACTORY_PRODUCT_ID,
        },
        provisioning: {
            artifactId: artifactId,
            productName: `${PAGESUITE_ACCOUNT_ID}_${ENVIRONMENT}`,
            parameters: {
                accountName: `${PAGESUITE_ACCOUNT_ID}_${ENVIRONMENT}`,
                accountEmail: `clients+${PAGESUITE_ACCOUNT_ID}+root@pagesuite.com`,
                ssoUserEmail: `clients+${PAGESUITE_ACCOUNT_ID}+admin@pagesuite.com`,
                ssoUserFirstName: "Admin",
                ssoUserLastName: `acc_${PAGESUITE_ACCOUNT_ID}`,
                managedOrganizationalUnit: organizationalUnit
            }
        },
        pageSuite: {
            accountId: PAGESUITE_ACCOUNT_ID,
            environment: ENVIRONMENT
        }
    });

    console.log();
}

function getOrganizationalUnitForEnvironment(environment: Environment): string {
    switch (environment) {
        case "Prod":
            return "Clients-Prod (ou-s4i4-4lggmwqt)";
        case "UAT":
            return "Clients-UAT (ou-s4i4-hrdijbmg)";
        case "Dev":
            return "Clients-Dev (ou-s4i4-0t2m7sl7)";
    }
}

interface RequestAwsAccountParams {
    product: {
        id: string;        
    }
    provisioning: {
        artifactId: string;
        productName: string;
        parameters: {
            accountName: string;
            accountEmail: string;
            ssoUserEmail: string;
            ssoUserFirstName: string;
            ssoUserLastName: string;
            managedOrganizationalUnit: string;
        }
    },
    pageSuite: {
        accountId: string;
        environment: string;
    }
}

async function requestAwsAccount(params: RequestAwsAccountParams): Promise<{ success: boolean; message: string }> {
    const cmdInput: ProvisionProductCommandInput = {
        ProductId: params.product.id,
        ProvisioningArtifactId: params.provisioning.artifactId,
        ProvisionedProductName: params.provisioning.productName,
        ProvisioningParameters: [
            { Key: "AccountName", Value: params.provisioning.parameters.accountName },
            { Key: "AccountEmail", Value: params.provisioning.parameters.accountEmail },
            { Key: "SSOUserEmail", Value: params.provisioning.parameters.ssoUserEmail },
            { Key: "SSOUserFirstName", Value: params.provisioning.parameters.ssoUserFirstName },
            { Key: "SSOUserLastName", Value: params.provisioning.parameters.ssoUserLastName },
            { Key: "ManagedOrganizationalUnit", Value: params.provisioning.parameters.managedOrganizationalUnit }
        ],
        Tags: [
            { Key: "ps:accountId", Value: params.pageSuite.accountId },
            { Key: "ps:environment", Value: params.pageSuite.environment },
        ]
    };

    try {
        const cmdOutput = await serviceCatalogClient.send(new ProvisionProductCommand(cmdInput));

        const status = cmdOutput.RecordDetail?.Status || 'UNKNOWN';

        return {
            success: status === 'CREATED' || status === 'IN_PROGRESS',
            message: `Account provisioning status: ${status}`
        };
    } catch (error) {
        return {
            success: false,
            message: `Failed to provision account: ${error}`
        };
    }
}

async function getLatestActiveArtifactId(): Promise<string> {
    const cmdInput: ListProvisioningArtifactsCommandInput = {
        ProductId: ACCOUNT_FACTORY_PRODUCT_ID
    };

    const cmdOutput = await serviceCatalogClient.send(new ListProvisioningArtifactsCommand(cmdInput));

    const activeArtifact = cmdOutput.ProvisioningArtifactDetails?.find(
        artifact => artifact.Active === true
    );

    if (!activeArtifact || !activeArtifact.Id) {
        throw new Error('No active provisioning artifact found for the product');
    }

    return activeArtifact.Id;
}

(async () => {
    await main();
})();