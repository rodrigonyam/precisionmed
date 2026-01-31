#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { PrecisionMedStack, PrecisionMedStackProps } from '../lib/precisionmed-stack';

const app = new cdk.App();

const env: cdk.Environment = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION || 'us-east-1',
};

const stackProps: PrecisionMedStackProps = {
  env,
  workloadName: 'precisionmed',
  healthLakeRegion: 'us-east-1',
  phiResidency: 'single-region',
  rpsTarget: 50,
  dailyPatients: 500,
  omicsMonthlyGb: 500,
  tlsCertificateArn: 'arn:aws:acm:us-east-1:123456789012:certificate/12345678-1234-1234-1234-123456789012',
  smartCallbackUrls: ['https://app.precisionmed.health/smart/callback'],
  smartLogoutUrls: ['https://app.precisionmed.health/logout'],
  smartAuthorizerLambdaArn: 'arn:aws:lambda:us-east-1:123456789012:function:SMARTAuthHandler:PROD',
  appImage: '123456789012.dkr.ecr.us-east-1.amazonaws.com/precisionmed-app:latest',
  inferenceImage: '123456789012.dkr.ecr.us-east-1.amazonaws.com/precisionmed-inference:latest',
  glueJobName: 'omics-etl-variant-call-v1',
  batchJobDefinitionArn: 'arn:aws:batch:us-east-1:123456789012:job-definition/OmicsEtlJobDef:1',
  batchQueueArn: 'arn:aws:batch:us-east-1:123456789012:job-queue/OmicsEtlQueue',
};

new PrecisionMedStack(app, 'PrecisionMedStack', stackProps);
