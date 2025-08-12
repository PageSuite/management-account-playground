import * as path from 'path';
import * as fs from 'fs';
import { CfnStackSet, Stack, StackProps } from 'aws-cdk-lib';
import { AttributeType, Billing, TableV2 } from 'aws-cdk-lib/aws-dynamodb';
import { Rule } from 'aws-cdk-lib/aws-events';
import { LambdaFunction } from 'aws-cdk-lib/aws-events-targets';
import { Architecture, Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

interface Environment {
    readonly name: string;
    readonly ouId: string;
    readonly trustedAccountId: string;
}

export class ManagementAccountPlaygroundStack extends Stack {
    constructor(scope: Construct, id: string, props?: StackProps) {
        super(scope, id, props);

        const provisionProductFunction = this.createProvisionProductFunction();
        const createAccountFunction = this.createCreateAccountFunction();
        const stacksetStatusFunction = this.createStacksetStatusFunction();

        const linkTable = this.createLinkTable();

        provisionProductFunction.addEnvironment('TABLE_NAME', linkTable.tableName);
        linkTable.grantReadWriteData(provisionProductFunction);

        createAccountFunction.addEnvironment('TABLE_NAME', linkTable.tableName);
        linkTable.grantReadWriteData(createAccountFunction);

        stacksetStatusFunction.addEnvironment('TABLE_NAME', linkTable.tableName);
        linkTable.grantReadWriteData(stacksetStatusFunction);
        stacksetStatusFunction.addToRolePolicy(new PolicyStatement({
            actions: ['organizations:DescribeAccount'],
            resources: ['*']
        }));

        const serviceCatalogEventRule = this.createServiceCatalogEventRule();
        serviceCatalogEventRule.addTarget(new LambdaFunction(provisionProductFunction));

        const controlTowerEventRule = this.createControlTowerEventRule();
        controlTowerEventRule.addTarget(new LambdaFunction(createAccountFunction));

        const stacksetEventRule = this.createStacksetEventRule();
        stacksetEventRule.addTarget(new LambdaFunction(stacksetStatusFunction));

        this.createClientAccessRoleStackSet();

        for (const env of ManagementAccountPlaygroundStack.ENVIRONMENTS) {
            this.createPageSuiteRoleStackSet(env);
        }
    }

    private static readonly ENVIRONMENTS: readonly Environment[] = [
        {
            name: 'Prod',
            ouId: 'ou-s4i4-4lggmwqt',
            trustedAccountId: '230905834734'
        },
        {
            name: 'UAT',
            ouId: 'ou-s4i4-hrdijbmg',
            trustedAccountId: '966849848650'
        },
        {
            name: 'Dev',
            ouId: 'ou-s4i4-0t2m7sl7',
            trustedAccountId: '403416458870'
        }
    ] as const;

    private createLinkTable() {
        // DynamoDB table to store the link between the AWS account/stage and the client account/stage
        return new TableV2(this, "LinkTable", {
            partitionKey: {
                name: "PK",
                type: AttributeType.STRING
            },
            sortKey: {
                name: "SK",
                type: AttributeType.STRING
            },
            billing: Billing.onDemand(),
            deletionProtection: true
        });
    }

    private createServiceCatalogEventRule() {
        // https://docs.aws.amazon.com/eventbridge/latest/ref/events-ref-servicecatalog.html
        return new Rule(this, 'ServiceCatalogEventRule', {
            eventPattern: {
                source: ['aws.servicecatalog'],
                detailType: ['AWS API Call via CloudTrail'],
                detail: {
                    eventSource: ['servicecatalog.amazonaws.com'],
                    eventName: ['ProvisionProduct']
                }
            },
            description: 'Capture Service Catalog Provision Product events via CloudTrail'
        });
    }

    private createControlTowerEventRule() {
        // https://docs.aws.amazon.com/controltower/latest/userguide/lifecycle-events.html
        return new Rule(this, 'ControlTowerEventRule', {
            eventPattern: {
                source: ['aws.controltower'],
                detailType: ['AWS Service Event via CloudTrail'],
                detail: {
                    eventSource: ['controltower.amazonaws.com'],
                    eventName: ['CreateManagedAccount']
                }
            },
            description: 'Capture Control Tower Create Managed Account events'
        });
    }

    private createStacksetEventRule() {
        // https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/event-detail-stackset-stack-instance-status-change.html
        return new Rule(this, 'StacksetEventRule', {
            eventPattern: {
                source: ['aws.cloudformation'],
                detailType: ['CloudFormation StackSet StackInstance Status Change'],
                detail: {
                    'stack-set-arn': [{ prefix: `arn:aws:cloudformation:${this.region}:${this.account}:stackset/PageSuiteRole-` }],
                    'status-details': {
                        'status': ['CURRENT']  // Only when stack instance is up-to-date with StackSet
                    }
                }
            },
            description: 'Capture successful PageSuiteRole StackSet deployments'
        });
    }

    private createProvisionProductFunction() {
        return new NodejsFunction(this, 'ProvisionProductFunction', {
            entry: path.join(__dirname, '../src/handlers/provision-product/index.ts'),
            runtime: Runtime.NODEJS_22_X,
            architecture: Architecture.ARM_64
        });
    }

    private createCreateAccountFunction() {
        return new NodejsFunction(this, 'CreateAccountFunction', {
            entry: path.join(__dirname, '../src/handlers/create-account/index.ts'),
            runtime: Runtime.NODEJS_22_X,
            architecture: Architecture.ARM_64
        });
    }

    private createStacksetStatusFunction() {
        return new NodejsFunction(this, 'StacksetStatusFunction', {
            entry: path.join(__dirname, '../src/handlers/stackset-status/index.ts'),
            runtime: Runtime.NODEJS_22_X,
            architecture: Architecture.ARM_64
        });
    }

    private createClientAccessRoleStackSet() {
        // StackSet to deploy ClientAccessRole to core AWS accounts
        return new CfnStackSet(this, 'ClientAccessRoleStackSet', {
            stackSetName: 'ClientAccessRole-StackSet',
            description: 'StackSet to deploy IAM user that can assume PageSuiteRole across accounts',
            permissionModel: 'SERVICE_MANAGED',
            templateBody: fs.readFileSync(path.join(__dirname, '../cloudformation/client-access-role.yaml'), 'utf-8'),
            capabilities: ['CAPABILITY_NAMED_IAM'],
            operationPreferences: {
                maxConcurrentCount: 1,  // Deploy to company accounts one at a time (only 3 accounts)
                failureToleranceCount: 0,  // Stop immediately on first failure - critical for core accounts
                regionConcurrencyType: 'SEQUENTIAL'  // Sequential for core infrastructure
            },
            autoDeployment: {
                enabled: true,
                retainStacksOnAccountRemoval: false
            },
            stackInstancesGroup: [{
                deploymentTargets: {
                    organizationalUnitIds: ['ou-s4i4-po2mje4a']
                },
                regions: [this.region]
            }]
        });
    }

    private createPageSuiteRoleStackSet(env: Environment) {
        // Define the environment configurations for PageSuiteRole StackSets
        // AWS limitation: Cannot have different parameter values for different OUs in a single SERVICE_MANAGED StackSet
        // Solution: Create separate StackSets for each environment, all using the same template
        return new CfnStackSet(this, `PageSuiteRole${env.name}StackSet`, {
            stackSetName: `PageSuiteRole-${env.name}-StackSet`,
            description: `StackSet to deploy PageSuiteRole to ${env.name} client accounts`,
            permissionModel: 'SERVICE_MANAGED',
            templateBody: fs.readFileSync(path.join(__dirname, '../cloudformation/pagesuite-role.yaml'), 'utf-8'),
            capabilities: ['CAPABILITY_NAMED_IAM'],
            operationPreferences: {
                maxConcurrentCount: 10,  // Deploy to 10 accounts at a time
                failureToleranceCount: 0,  // Stop on first failure (0 tolerance)
                regionConcurrencyType: 'PARALLEL'
            },
            autoDeployment: {
                enabled: true,
                retainStacksOnAccountRemoval: false
            },
            stackInstancesGroup: [{
                deploymentTargets: {
                    organizationalUnitIds: [env.ouId]
                },
                regions: [this.region]
            }],
            parameters: [{
                parameterKey: 'TrustedAccountId',
                parameterValue: env.trustedAccountId
            }]
        });
    }
}
