/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License").
 * You may not use this file except in compliance with the License.
 * A copy of the License is located at
 *
 * http://aws.amazon.com/apache2.0
 *
 * or in the "license" file accompanying this file. This file is distributed
 * on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either
 * express or implied. See the License for the specific language governing
 * permissions and limitations under the License.
 */

const _ = require('lodash');
const Service = require('@aws-ee/base-services-container/lib/service');

const settingKeys = {
  appStreamImageName: 'appStreamImageName',
};

class AppStreamScService extends Service {
  constructor() {
    super();
    this.dependency([
      'auditWriterService',
      'aws',
      'awsAccountsService',
      'environmentScKeypairService',
      'environmentScService',
      'indexesService',
    ]);
  }

  async init() {
    await super.init();
    const aws = await this.service('aws');
    this.appStream = new aws.sdk.AppStream();
  }

  async shareAppStreamImageWithAccount(requestContext, accountId) {
    const result = await this.appStream
      .updateImagePermissions({
        ImagePermissions: {
          allowFleet: true,
          allowImageBuilder: false,
        },
        Name: this.settings.get(settingKeys.appStreamImageName),
        SharedAccountId: accountId,
      })
      .promise();

    // Write audit event
    await this.audit(requestContext, { action: 'share-appstream-image-with-account', body: { accountId } });

    return result;
  }

  async getStackAndFleet(requestContext, { environmentId, indexId }) {
    const [environmentScService, awsAccountsService, indexesService] = await this.service([
      'environmentScService',
      'awsAccountsService',
      'indexesService',
    ]);

    // Find stack
    const { awsAccountId } = await indexesService.mustFind(requestContext, { id: indexId });
    const {
      appStreamStackName: stackName,
      accountId,
      appStreamFleetName: fleetName,
    } = await awsAccountsService.mustFind(requestContext, {
      id: awsAccountId,
    });

    if (!stackName) {
      throw this.boom.badRequest(
        `Expected stack ${stackName} to be associated with the account ${accountId} but found`,
        true,
      );
    }

    // Verify fleet is associated to appstream stack
    const appStream = await environmentScService.getClientSdkWithEnvMgmtRole(
      requestContext,
      { id: environmentId },
      { clientName: 'AppStream', options: { signatureVersion: 'v4' } },
    );
    const { Names: fleetNames } = await appStream.listAssociatedFleets({ StackName: stackName }).promise();

    if (!_.includes(fleetNames, fleetName)) {
      throw this.boom.badRequest(
        `Expected fleet ${fleetName} to be associated with the AppStream stack but found`,
        true,
      );
    }

    return { stackName, fleetName };
  }

  generateSessionSuffix(environment) {
    // Generate a unique session suffix for the environment as a 6 character alphanumeric string
    // This is random looking but string but is deterministic so can be derived from the environment
    return (new Date(environment.createdAt).getTime() % 36 ** 6).toString(36);
  }

  generateUserId(requestContext, environment) {
    // UserId must match [\w+=,.@-]* with max length 32
    // Don't let the username be too long (otherwise the user won't be able to open multiple sessions)
    const uid = _.get(requestContext, 'principalIdentifier.uid');
    // Append a unique session suffix to the user id, this user id is used for creating unique AppStream session
    // appending suffix to make sure a unique session is created per environment per user
    const sessionSuffix = this.generateSessionSuffix(environment);
    return `${uid}-${sessionSuffix}`.replace(/[^\w+=,.@-]+/g, '').slice(0, 32);
  }

  async urlForFirefox(requestContext, { environmentId }) {
    const environmentScService = await this.service('environmentScService');

    const appStream = await environmentScService.getClientSdkWithEnvMgmtRole(
      requestContext,
      { id: environmentId },
      { clientName: 'AppStream', options: { signatureVersion: 'v4' } },
    );

    const environment = await environmentScService.mustFind(requestContext, { id: environmentId });

    const { stackName, fleetName } = await this.getStackAndFleet(requestContext, {
      environmentId,
      indexId: environment.indexId,
    });

    const result = await appStream
      .createStreamingURL({
        FleetName: fleetName,
        StackName: stackName,
        UserId: this.generateUserId(requestContext, environment),
        ApplicationId: 'Firefox',
      })
      .promise();

    // Write audit event
    await this.audit(requestContext, { action: 'appstream-firefox-app-url-requested', body: { environmentId } });

    return result.StreamingURL;
  }

  async urlForRemoteDesktop(requestContext, { environmentId, instanceId }) {
    const [environmentScKeypairService, environmentScService] = await this.service([
      'environmentScKeypairService',
      'environmentScService',
    ]);

    const environment = await environmentScService.mustFind(requestContext, { id: environmentId });

    // Get stack and fleet
    const { stackName, fleetName } = await this.getStackAndFleet(requestContext, {
      environmentId,
      indexId: environment.indexId,
    });

    // Create session context
    const environmentKey = environmentScKeypairService.toPrivateKeySsmParamName(environmentId);
    const sessionContext = { environmentKey, instanceId };

    // Generate AppStream URL
    const appStream = await environmentScService.getClientSdkWithEnvMgmtRole(
      requestContext,
      { id: environmentId },
      { clientName: 'AppStream', options: { signatureVersion: 'v4' } },
    );
    const userId = this.generateUserId(requestContext, environment);
    this.log.info({ msg: `Creating AppStream URL`, appStreamSessionUid: userId });
    const result = await appStream
      .createStreamingURL({
        FleetName: fleetName,
        StackName: stackName,
        UserId: userId,
        ApplicationId: 'remote-desktop',
        SessionContext: JSON.stringify(sessionContext),
      })
      .promise();

    // Write audit event
    await this.audit(requestContext, { action: 'appstream-remote-desktop-app-url-requested', body: { environmentId } });

    return result.StreamingURL;
  }

  async audit(requestContext, auditEvent) {
    const auditWriterService = await this.service('auditWriterService');
    // Calling "writeAndForget" instead of "write" to allow main call to continue without waiting for audit logging
    // and not fail main call if audit writing fails for some reason
    // If the main call also needs to fail in case writing to any audit destination fails then switch to "write" method as follows
    // return auditWriterService.write(requestContext, auditEvent);
    return auditWriterService.writeAndForget(requestContext, auditEvent);
  }
}

module.exports = AppStreamScService;
