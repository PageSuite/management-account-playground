#!/usr/bin/env node
import { App } from 'aws-cdk-lib';
import { ManagementAccountPlaygroundStack } from '../lib/management-account-playground-stack';

const app = new App();
new ManagementAccountPlaygroundStack(app, 'ManagementAccountPlaygroundStack', {
    env: { account: '447677561119', region: 'eu-west-1' },
});