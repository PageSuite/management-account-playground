import { STSClient, AssumeRoleCommand, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { S3Client, ListBucketsCommand } from '@aws-sdk/client-s3';
import { EC2Client, DescribeInstancesCommand } from '@aws-sdk/client-ec2';
import { IAMClient, ListUsersCommand } from '@aws-sdk/client-iam';
import { fromSSO } from '@aws-sdk/credential-providers';

// TYPE DEFINITIONS
type Environment = "Prod" | "UAT" | "Dev";

const ENVIRONMENTS = {
    Prod: {
        accountId: '230905834734',
        ssoProfile: 'production'
    },
    UAT: {
        accountId: '966849848650',
        ssoProfile: 'uat'
    },
    Dev: {
        accountId: '403416458870',
        ssoProfile: 'development'
    }
} as const;

async function testRoleChain(environment: Environment, pageSuiteRoleArn: string) {
    console.log(`\n🔧 Testing role chain for ${environment} → ${pageSuiteRoleArn}`);
    
    try {
        const envConfig = ENVIRONMENTS[environment];
        
        console.log(`📝 Using SSO profile: ${envConfig.ssoProfile}`);
        const stsClient = new STSClient({
            region: 'us-east-1',
            credentials: fromSSO({ profile: envConfig.ssoProfile })
        });

        console.log('1️⃣  Assuming ClientAccessRole...');
        const clientAccessRoleArn = `arn:aws:iam::${envConfig.accountId}:role/ClientAccessRole`;
        const clientAccessResponse = await stsClient.send(new AssumeRoleCommand({
            RoleArn: clientAccessRoleArn,
            RoleSessionName: 'test-client-access-session'
        }));

        if (!clientAccessResponse.Credentials) {
            throw new Error('Failed to get credentials from ClientAccessRole');
        }

        const clientAccessSts = new STSClient({
            region: 'us-east-1',
            credentials: {
                accessKeyId: clientAccessResponse.Credentials.AccessKeyId!,
                secretAccessKey: clientAccessResponse.Credentials.SecretAccessKey!,
                sessionToken: clientAccessResponse.Credentials.SessionToken!
            }
        });

        console.log('2️⃣  Assuming PageSuiteRole in target account...');
        const pageSuiteResponse = await clientAccessSts.send(new AssumeRoleCommand({
            RoleArn: pageSuiteRoleArn,
            RoleSessionName: 'test-pagesuite-session'
        }));

        if (!pageSuiteResponse.Credentials) {
            throw new Error('Failed to get credentials from PageSuiteRole');
        }

        const pageSuiteCredentials = {
            accessKeyId: pageSuiteResponse.Credentials.AccessKeyId!,
            secretAccessKey: pageSuiteResponse.Credentials.SecretAccessKey!,
            sessionToken: pageSuiteResponse.Credentials.SessionToken!
        };

        console.log('\n3️⃣  Testing PageSuiteRole permissions...\n');
        
        // Test S3 permissions (SHOULD WORK)
        console.log('📦 Testing S3 access (should succeed):');
        try {
            const s3Client = new S3Client({
                region: 'us-east-1',
                credentials: pageSuiteCredentials
            });
            
            const bucketsResponse = await s3Client.send(new ListBucketsCommand({}));
            console.log(`   ✅ S3 ListBuckets: SUCCESS - Found ${bucketsResponse.Buckets?.length || 0} buckets`);
            if (bucketsResponse.Buckets && bucketsResponse.Buckets.length > 0) {
                console.log(`      First bucket: ${bucketsResponse.Buckets[0].Name}`);
            }
        } catch (error) {
            console.log(`   ❌ S3 ListBuckets: FAILED - ${error instanceof Error ? error.message : error}`);
        }

        // Test EC2 permissions (SHOULD FAIL)
        console.log('\n🖥️  Testing EC2 access (should fail):');
        try {
            const ec2Client = new EC2Client({
                region: 'us-east-1',
                credentials: pageSuiteCredentials
            });
            
            await ec2Client.send(new DescribeInstancesCommand({}));
            console.log('   ❌ EC2 DescribeInstances: UNEXPECTED SUCCESS - This should have been denied!');
        } catch (error) {
            console.log(`   ✅ EC2 DescribeInstances: DENIED (as expected) - ${error instanceof Error ? error.message : error}`);
        }

        // Test IAM permissions (SHOULD FAIL)
        console.log('\n👤 Testing IAM access (should fail):');
        try {
            const iamClient = new IAMClient({
                region: 'us-east-1',
                credentials: pageSuiteCredentials
            });
            
            await iamClient.send(new ListUsersCommand({}));
            console.log('   ❌ IAM ListUsers: UNEXPECTED SUCCESS - This should have been denied!');
        } catch (error) {
            console.log(`   ✅ IAM ListUsers: DENIED (as expected) - ${error instanceof Error ? error.message : error}`);
        }

        // Test STS GetCallerIdentity (SHOULD WORK - this is always allowed)
        console.log('\n🔐 Testing STS GetCallerIdentity (always allowed):');
        try {
            const stsClientWithPageSuite = new STSClient({
                region: 'us-east-1',
                credentials: pageSuiteCredentials
            });
            
            const identity = await stsClientWithPageSuite.send(new GetCallerIdentityCommand({}));
            console.log(`   ✅ Current identity: ${identity.Arn}`);
        } catch (error) {
            console.log(`   ❌ STS GetCallerIdentity: FAILED - ${error instanceof Error ? error.message : error}`);
        }

        console.log('\n📊 Summary: PageSuiteRole permissions test complete!');

    } catch (error) {
        console.error('❌ Error:', error instanceof Error ? error.message : error);
        if (error instanceof Error && error.message.includes('SSO')) {
            console.log('\n💡 Tip: Make sure you are logged in to AWS SSO:');
            console.log('   aws sso login --profile ' + ENVIRONMENTS[environment].ssoProfile);
        }
    }
}

async function main() {
    // INPUT VALUES - Update these
    const ENVIRONMENT: Environment = "Dev";
    const PAGE_SUITE_ROLE_ARN = "arn:aws:iam::575935530000:role/PageSuiteRole";  // Replace with actual PageSuiteRole ARN
    
    console.log(`Testing with core account: ${ENVIRONMENT}`);
    console.log(`Target role: ${PAGE_SUITE_ROLE_ARN}`);
    
    await testRoleChain(ENVIRONMENT, PAGE_SUITE_ROLE_ARN);
}

main().catch(console.error);