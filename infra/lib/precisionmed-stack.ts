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
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';

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
  glueJobName?: string;
  batchJobDefinitionArn?: string;
  batchQueueArn?: string;
}

export class PrecisionMedStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: PrecisionMedStackProps) {
    super(scope, id, props);

    const {
      workloadName,
      smartCallbackUrls,
      smartLogoutUrls,
      smartAuthorizerLambdaArn,
      appImage,
      inferenceImage,
      glueJobName,
      batchJobDefinitionArn,
      batchQueueArn,
    } = props;

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

    const endpointSecurityGroup = new ec2.SecurityGroup(this, 'VpcEndpointSg', {
      vpc,
      description: 'Interface endpoints security group',
      allowAllOutbound: true,
    });

    vpc.addGatewayEndpoint('S3GatewayEndpoint', {
      service: ec2.GatewayVpcEndpointAwsService.S3,
      subnets: [{ subnetGroupName: 'Data' }, { subnetGroupName: 'App' }],
    });

    vpc.addInterfaceEndpoint('EcrApiEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.ECR,
      securityGroups: [endpointSecurityGroup],
      subnets: { subnetGroupName: 'App' },
    });

    vpc.addInterfaceEndpoint('EcrDkrEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER,
      securityGroups: [endpointSecurityGroup],
      subnets: { subnetGroupName: 'App' },
    });

    vpc.addInterfaceEndpoint('CloudWatchLogsEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS,
      securityGroups: [endpointSecurityGroup],
      subnets: { subnetGroupName: 'App' },
    });

    vpc.addInterfaceEndpoint('KmsEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.KMS,
      securityGroups: [endpointSecurityGroup],
      subnets: { subnetGroupName: 'App' },
    });

    vpc.addInterfaceEndpoint('HealthLakeEndpoint', {
      service: { name: `com.amazonaws.${cdk.Aws.REGION}.healthlake`, port: 443 },
      securityGroups: [endpointSecurityGroup],
      subnets: { subnetGroupName: 'App' },
      privateDnsEnabled: true,
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

    const fhirDatastore = new healthlake.CfnFHIRDatastore(this, 'FhirDatastore', {
      datastoreName: `${workloadName}-fhir`,
      datastoreTypeVersion: 'R4',
      preloadDataConfig: { preloadDataType: 'SYNTHEA' },
      sseConfiguration: { kmsEncryptionConfig: { cmkType: 'CUSTOMER_MANAGED_KMS_KEY', kmsKeyId: key.keyArn } },
      identityProviderConfiguration: {
        authorizationStrategy: 'SMART_ON_FHIR',
        fineGrainedAuthorizationEnabled: true,
        idpLambdaArn: smartAuthorizerLambdaArn,
      },
    });

    const dbCredentials = rds.Credentials.fromGeneratedSecret('fhir_omop_admin');

    const appSharedSecret = new secretsmanager.Secret(this, 'AppSharedSecret', {
      secretName: `${workloadName}-app-shared`,
      generateSecretString: { secretStringTemplate: '{}', generateStringKey: 'jwt_secret', excludePunctuation: true },
    });

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
        image: ecs.ContainerImage.fromRegistry(appImage),
        containerPort: 3000,
        enableLogging: true,
        logDriver: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: 'app' }),
        environment: {
          APP_ENV: 'prod',
          FHIR_DATASTORE_ENDPOINT: fhirDatastore.attrDatastoreEndpoint,
          FHIR_REGION: props.healthLakeRegion,
          SMART_ISSUER: `https://${userPool.userPoolProviderUrl}`,
          SMART_CLIENT_ID: userPoolClient.userPoolClientId,
          OMOP_DB_HOST: postgres.dbInstanceEndpointAddress,
          OMOP_DB_PORT: postgres.dbInstanceEndpointPort,
          OMOP_DB_NAME: 'postgres',
          OMOP_DB_USER: dbCredentials.username,
          OMOP_DB_SSLMODE: 'require',
          INFERENCE_URL: '',
        },
        secrets: {
          OMOP_DB_PASSWORD: ecs.Secret.fromSecretsManager(postgres.secret!, 'password'),
          APP_SHARED_SECRET: ecs.Secret.fromSecretsManager(appSharedSecret, 'jwt_secret'),
        },
        taskRole,
        executionRole,
      },
    });

    postgres.connections.allowFrom(fargateService.service, ec2.Port.tcp(5432));

    const inferenceSecurityGroup = new ec2.SecurityGroup(this, 'InferenceSg', {
      vpc,
      description: 'Inference tasks',
      allowAllOutbound: true,
    });
    inferenceSecurityGroup.addIngressRule(appSecurityGroup, ec2.Port.tcp(8080), 'App to inference');
    dbSecurityGroup.addIngressRule(inferenceSecurityGroup, ec2.Port.tcp(5432), 'Inference to Postgres');

    const inferenceLogGroup = new logs.LogGroup(this, 'InferenceLogs', {
      logGroupName: `/aws/${workloadName}/inference`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const inferenceService = new ecsPatterns.NetworkLoadBalancedFargateService(this, 'InferenceService', {
      cluster,
      cpu: 512,
      memoryLimitMiB: 1024,
      desiredCount: 1,
      listenerPort: 8080,
      publicLoadBalancer: false,
      taskSubnets: { subnetGroupName: 'App' },
      securityGroups: [inferenceSecurityGroup],
      taskImageOptions: {
        image: ecs.ContainerImage.fromRegistry(inferenceImage),
        containerPort: 8080,
        enableLogging: true,
        logDriver: ecs.LogDrivers.awsLogs({ logGroup: inferenceLogGroup, streamPrefix: 'inference' }),
        environment: {
          APP_ENV: 'prod',
          FHIR_DATASTORE_ENDPOINT: fhirDatastore.attrDatastoreEndpoint,
          FHIR_REGION: props.healthLakeRegion,
          OMOP_DB_HOST: postgres.dbInstanceEndpointAddress,
          OMOP_DB_PORT: postgres.dbInstanceEndpointPort,
          OMOP_DB_NAME: 'postgres',
          OMOP_DB_USER: dbCredentials.username,
          APP_SERVICE_URL: `http://${fargateService.loadBalancer.loadBalancerDnsName}`,
          OMOP_DB_SSLMODE: 'require',
        },
        secrets: {
          OMOP_DB_PASSWORD: ecs.Secret.fromSecretsManager(postgres.secret!, 'password'),
          APP_SHARED_SECRET: ecs.Secret.fromSecretsManager(appSharedSecret, 'jwt_secret'),
        },
        taskRole,
        executionRole,
      },
    });

    if (fargateService.taskDefinition.defaultContainer) {
      fargateService.taskDefinition.defaultContainer.addEnvironment(
        'INFERENCE_URL',
        `http://${inferenceService.loadBalancer.loadBalancerDnsName}:8080/insights`,
      );
    }

    const webAcl = new wafv2.CfnWebACL(this, 'AppWebAcl', {
      scope: 'REGIONAL',
      defaultAction: { allow: {} },
      visibilityConfig: { cloudWatchMetricsEnabled: true, metricName: `${workloadName}-waf`, sampledRequestsEnabled: true },
      rules: [
        {
          name: 'AWS-AWSManagedRulesCommonRuleSet',
          priority: 1,
          overrideAction: { none: {} },
          statement: { managedRuleGroupStatement: { vendorName: 'AWS', name: 'AWSManagedRulesCommonRuleSet' } },
          visibilityConfig: { cloudWatchMetricsEnabled: true, metricName: 'common', sampledRequestsEnabled: true },
        },
        {
          name: 'AWS-AWSManagedRulesSQLiRuleSet',
          priority: 2,
          overrideAction: { none: {} },
          statement: { managedRuleGroupStatement: { vendorName: 'AWS', name: 'AWSManagedRulesSQLiRuleSet' } },
          visibilityConfig: { cloudWatchMetricsEnabled: true, metricName: 'sqli', sampledRequestsEnabled: true },
        },
      ],
    });

    new wafv2.CfnWebACLAssociation(this, 'WebAclAssoc', {
      webAclArn: webAcl.attrArn,
      resourceArn: fargateService.loadBalancer.loadBalancerArn,
    });

    const searchSecurityGroup = new ec2.SecurityGroup(this, 'SearchSg', {
      vpc,
      description: 'OpenSearch access from app and inference',
      allowAllOutbound: true,
    });
    searchSecurityGroup.addIngressRule(appSecurityGroup, ec2.Port.tcp(443), 'App to search');
    searchSecurityGroup.addIngressRule(inferenceSecurityGroup, ec2.Port.tcp(443), 'Inference to search');

    const searchMasterUser = new secretsmanager.Secret(this, 'SearchMasterUser', {
      secretName: `${workloadName}-search-master`,
      generateSecretString: { secretStringTemplate: '{"username":"searchadmin"}', generateStringKey: 'password', excludePunctuation: true },
    });

    searchMasterUser.grantRead(taskRole);

    const searchDomain = new opensearch.Domain(this, 'SearchDomain', {
      version: opensearch.EngineVersion.OPENSEARCH_2_11,
      domainName: `${workloadName}-search`,
      capacity: { masterNodes: 0, dataNodes: 2, dataNodeInstanceType: 't3.small.search' },
      ebs: { enabled: true, volumeSize: 50, volumeType: ec2.EbsDeviceVolumeType.GP3 },
      zoneAwareness: { enabled: true },
      vpc,
      vpcSubnets: [{ subnetGroupName: 'Data' }],
      securityGroups: [searchSecurityGroup],
      enforceHttps: true,
      nodeToNodeEncryption: true,
      encryptionAtRest: { enabled: true, kmsKey: key },
      fineGrainedAccessControl: { masterUserName: 'searchadmin', masterUserPassword: searchMasterUser.secretValueFromJson('password') },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    searchDomain.grantReadWrite(taskRole);

    const etlRole = new iam.Role(this, 'EtlStateMachineRole', {
      assumedBy: new iam.ServicePrincipal('states.amazonaws.com'),
    });

    if (props.glueJobName) {
      etlRole.addToPolicy(
        new iam.PolicyStatement({
          actions: ['glue:StartJobRun', 'glue:GetJobRun'],
          resources: [
            `arn:${cdk.Aws.PARTITION}:glue:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:job/${props.glueJobName}`,
            `arn:${cdk.Aws.PARTITION}:glue:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:job/${props.glueJobName}:*`,
          ],
        }),
      );
    }

    if (props.batchJobDefinitionArn && props.batchQueueArn) {
      etlRole.addToPolicy(
        new iam.PolicyStatement({
          actions: ['batch:SubmitJob', 'batch:DescribeJobs'],
          resources: [props.batchJobDefinitionArn, props.batchQueueArn],
        }),
      );
    }

    const glueTask = glueJobName
      ? new tasks.GlueStartJobRun(this, 'GlueOmicsEtl', {
          jobName: glueJobName,
          integrationPattern: sfn.IntegrationPattern.RUN_JOB,
        })
      : new sfn.Pass(this, 'GlueOmicsEtlPlaceholder');

    const batchTask = batchJobDefinitionArn && batchQueueArn
      ? new tasks.BatchSubmitJob(this, 'BatchOmicsStep', {
          jobDefinitionArn: batchJobDefinitionArn,
          jobName: 'omics-etl-batch-step',
          jobQueueArn: batchQueueArn,
        })
      : new sfn.Pass(this, 'BatchOmicsPlaceholder');

    const etlDefinition = glueTask.next(batchTask);

    const etlStateMachine = new sfn.StateMachine(this, 'OmicsEtlStateMachine', {
      definition: etlDefinition,
      tracingEnabled: true,
      role: etlRole,
      stateMachineName: `${workloadName}-omics-etl`,
    });

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

    new cdk.CfnOutput(this, 'VpcId', { value: vpc.vpcId });
    new cdk.CfnOutput(this, 'AppUrl', { value: `https://${fargateService.loadBalancer.loadBalancerDnsName}` });
    new cdk.CfnOutput(this, 'InferenceNlbDns', { value: inferenceService.loadBalancer.loadBalancerDnsName });
    new cdk.CfnOutput(this, 'DbSecret', { value: postgres.secret?.secretArn ?? 'n/a' });
    new cdk.CfnOutput(this, 'RawBucketName', { value: rawBucket.bucketName });
    new cdk.CfnOutput(this, 'CuratedBucketName', { value: curatedBucket.bucketName });
    new cdk.CfnOutput(this, 'FeatureBucketName', { value: featureBucket.bucketName });
    new cdk.CfnOutput(this, 'CognitoUserPoolId', { value: userPool.userPoolId });
    new cdk.CfnOutput(this, 'CognitoClientId', { value: userPoolClient.userPoolClientId });
    new cdk.CfnOutput(this, 'SearchDomainEndpoint', { value: searchDomain.domainEndpoint });
    new cdk.CfnOutput(this, 'OmicsEtlStateMachineArn', { value: etlStateMachine.stateMachineArn });
  }
}
