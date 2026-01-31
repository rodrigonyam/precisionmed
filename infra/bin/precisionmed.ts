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
  tlsCertificateArn: 'arn:aws:acm:us-east-1:123456789012:certificate/REPLACE_ME',
  smartCallbackUrls: ['https://example.com/smart/callback'],
  smartLogoutUrls: ['https://example.com/logout'],
};

new PrecisionMedStack(app, 'PrecisionMedStack', stackProps);
