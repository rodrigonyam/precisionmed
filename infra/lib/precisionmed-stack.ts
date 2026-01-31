import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecsPatterns from 'aws-cdk-lib/aws-ecs-patterns';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as healthlake from 'aws-cdk-lib/aws-healthlake';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import * as opensearch from 'aws-cdk-lib/aws-opensearchservice';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';

export interface PrecisionMedStackProps extends cdk.StackProps {
  workloadName: string;
  healthLakeRegion: string;
  phiResidency: 'single-region' | 'multi-region-dr';
  rpsTarget: number;
  dailyPatients: number;
  omicsMonthlyGb: number;
  tlsCertificateArn: string;
  smartCallbackUrls: string[];
  smartLogoutUrls: string[];
  smartAuthorizerLambdaArn: string;
  appImage: string;
  inferenceImage: string;
}

export class PrecisionMedStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: PrecisionMedStackProps) {
    super(scope, id, props);

    const { workloadName, smartCallbackUrls, smartLogoutUrls, smartAuthorizerLambdaArn, appImage, inferenceImage } = props;

    const key = new kms.Key(this, 'KmsKey', {
      alias: `${workloadName}-kms`,
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        { name: 'Public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'App', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
        { name: 'Data', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });

    const logGroup = new logs.LogGroup(this, 'AppLogs', {
      logGroupName: `/aws/${workloadName}/app`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const rawBucket = new s3.Bucket(this, 'RawBucket', {
      bucketName: `${workloadName}-raw-${cdk.Aws.ACCOUNT_ID}-${cdk.Aws.REGION}`,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: key,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      autoDeleteObjects: false,
    });

    const curatedBucket = new s3.Bucket(this, 'CuratedBucket', {
      bucketName: `${workloadName}-curated-${cdk.Aws.ACCOUNT_ID}-${cdk.Aws.REGION}`,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: key,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      autoDeleteObjects: false,
    });

    const featureBucket = new s3.Bucket(this, 'FeatureBucket', {
      bucketName: `${workloadName}-features-${cdk.Aws.ACCOUNT_ID}-${cdk.Aws.REGION}`,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: key,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      autoDeleteObjects: false,
    });

    const dbCredentials = rds.Credentials.fromGeneratedSecret('fhir_omop_admin');

    const dbSecurityGroup = new ec2.SecurityGroup(this, 'DbSecurityGroup', {
      vpc,
      description: 'Allow RDS Postgres access from ECS tasks',
      allowAllOutbound: true,
    });

    const appSecurityGroup = new ec2.SecurityGroup(this, 'AppSecurityGroup', {
      vpc,
      description: 'App tasks security group',
      allowAllOutbound: true,
    });

    dbSecurityGroup.addIngressRule(appSecurityGroup, ec2.Port.tcp(5432), 'ECS to Postgres');

    const dbParameterGroup = new rds.ParameterGroup(this, 'PgParameters', {
      engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.V15_4 }),
      parameters: { 'rds.force_ssl': '1' },
    });

    const postgres = new rds.DatabaseInstance(this, 'OmopPostgres', {
      engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.V15_4 }),
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.LARGE),
      vpc,
      vpcSubnets: { subnetGroupName: 'Data' },
      multiAz: true,
      allocatedStorage: 200,
      storageEncrypted: true,
      storageEncryptionKey: key,
      credentials: dbCredentials,
      backupRetention: cdk.Duration.days(7),
      deletionProtection: true,
      publiclyAccessible: false,
      securityGroups: [dbSecurityGroup],
      cloudwatchLogsExports: ['postgresql', 'upgrade'],
      parameterGroup: dbParameterGroup,
    });

    const cluster = new ecs.Cluster(this, 'EcsCluster', {
      vpc,
      containerInsights: true,
      clusterName: `${workloadName}-cluster`,
    });

    const taskRole = new iam.Role(this, 'TaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });

    const executionRole = new iam.Role(this, 'ExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy')],
    });

    rawBucket.grantReadWrite(taskRole);
    curatedBucket.grantReadWrite(taskRole);
    featureBucket.grantReadWrite(taskRole);
    postgres.secret?.grantRead(taskRole);

    const fargateService = new ecsPatterns.ApplicationLoadBalancedFargateService(this, 'AppService', {
      cluster,
      cpu: 512,
      memoryLimitMiB: 1024,
      desiredCount: 2,
      protocol: elbv2.ApplicationProtocol.HTTPS,
      listenerPort: 443,
      certificate: elbv2.ListenerCertificate.fromArn(props.tlsCertificateArn),
      redirectHTTP: true,
      circuitBreaker: { rollback: true },
      publicLoadBalancer: false,
      assignPublicIp: false,
      taskSubnets: { subnetGroupName: 'App' },
      securityGroups: [appSecurityGroup],
      taskImageOptions: {
        image: ecs.ContainerImage.fromRegistry('public.ecr.aws/docker/library/nginx:latest'),
        containerPort: 3000,
        enableLogging: true,
        logDriver: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: 'app' }),
        environment: {
          APP_ENV: 'prod',
        },
        taskRole,
        executionRole,
      },
    });

    postgres.connections.allowFrom(fargateService.service, ec2.Port.tcp(5432));

    const userPool = new cognito.UserPool(this, 'CognitoPool', {
      userPoolName: `${workloadName}-users`,
      selfSignUpEnabled: false,
      signInAliases: { email: true, preferredUsername: true },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      passwordPolicy: { minLength: 12, requireLowercase: true, requireUppercase: true, requireDigits: true, requireSymbols: true },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      mfa: cognito.Mfa.REQUIRED,
      mfaSecondFactor: { sms: false, otp: true },
    });

    const userPoolClient = new cognito.UserPoolClient(this, 'CognitoAppClient', {
      userPool,
      generateSecret: true,
      authFlows: { userPassword: false, userSrp: true, adminUserPassword: false, custom: false },
      oAuth: {
        flows: { authorizationCodeGrant: true },
        callbackUrls: smartCallbackUrls,
        logoutUrls: smartLogoutUrls,
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
      },
    });

    new cognito.CfnUserPoolGroup(this, 'ClinicianGroup', { userPoolId: userPool.userPoolId, groupName: 'clinician' });
    new cognito.CfnUserPoolGroup(this, 'PatientGroup', { userPoolId: userPool.userPoolId, groupName: 'patient' });
    new cognito.CfnUserPoolGroup(this, 'CaregiverGroup', { userPoolId: userPool.userPoolId, groupName: 'caregiver' });
    new cognito.CfnUserPoolGroup(this, 'AdminGroup', { userPoolId: userPool.userPoolId, groupName: 'admin' });

    new healthlake.CfnFHIRDatastore(this, 'FhirDatastore', {
      datastoreName: `${workloadName}-fhir`,
      datastoreTypeVersion: 'R4',
      preloadDataConfig: { preloadDataType: 'SYNTHEA' },
      sseConfiguration: { kmsEncryptionConfig: { cmkType: 'CUSTOMER_MANAGED_KMS_KEY', kmsKeyId: key.keyArn } },
      identityProviderConfiguration: {
        authorizationStrategy: 'SMART_ON_FHIR',
        fineGrainedAuthorizationEnabled: true,
        idpLambdaArn: 'arn:aws:lambda:region:account:function:placeholder-smart-authorizer',
      },
    });

    new cdk.CfnOutput(this, 'VpcId', { value: vpc.vpcId });
    new cdk.CfnOutput(this, 'AppUrl', { value: `https://${fargateService.loadBalancer.loadBalancerDnsName}` });
    new cdk.CfnOutput(this, 'DbSecret', { value: postgres.secret?.secretArn ?? 'n/a' });
    new cdk.CfnOutput(this, 'RawBucketName', { value: rawBucket.bucketName });
    new cdk.CfnOutput(this, 'CuratedBucketName', { value: curatedBucket.bucketName });
    new cdk.CfnOutput(this, 'FeatureBucketName', { value: featureBucket.bucketName });
    new cdk.CfnOutput(this, 'CognitoUserPoolId', { value: userPool.userPoolId });
    new cdk.CfnOutput(this, 'CognitoClientId', { value: userPoolClient.userPoolClientId });
  }
}
