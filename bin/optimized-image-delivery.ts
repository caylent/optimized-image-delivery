#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import {OptimizedImageDeliveryStack} from '../lib/optimized-image-delivery-stack';

const app = new cdk.App();

if (!process.env.APEX_DOMAIN || !process.env.SUBDOMAIN || !process.env.STACK_ID) {
    console.error("You need to define 'APEX_DOMAIN', 'SUBDOMAIN' and 'STACK_ID' as env vars");
    process.exit(1)
}

new OptimizedImageDeliveryStack(app, 'OptimizedImageDeliveryStack', {
    env: {account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION},
    apexDomain: process.env.APEX_DOMAIN,
    subdomain: process.env.SUBDOMAIN,
    stackId: process.env.STACK_ID
});