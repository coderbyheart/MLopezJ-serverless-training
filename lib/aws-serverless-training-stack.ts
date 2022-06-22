import * as cdk from 'aws-cdk-lib';
import * as path from 'path';
import { Duration, CfnOutput } from 'aws-cdk-lib';
import s3 = require('aws-cdk-lib/aws-s3');
import dynamodb = require('aws-cdk-lib/aws-dynamodb');
import lambda = require('aws-cdk-lib/aws-lambda');
import iam = require('aws-cdk-lib/aws-iam');
import event_sources = require('aws-cdk-lib/aws-lambda-event-sources');
import apigw = require('aws-cdk-lib/aws-apigateway');
import { AuthorizationType, PassthroughBehavior } from 'aws-cdk-lib/aws-apigateway';
import cognito = require('aws-cdk-lib/aws-cognito');
import s3deploy = require('aws-cdk-lib/aws-s3-deployment');
import { HttpMethods } from 'aws-cdk-lib/aws-s3';
import sqs = require('aws-cdk-lib/aws-sqs');
import s3n = require('aws-cdk-lib/aws-s3-notifications');
import { Construct } from 'constructs';
import {NodejsFunction} from 'aws-cdk-lib/aws-lambda-nodejs'; 

// This is the CDK internal resource ID, not the S3 bucket name!
const imageBucketResourceId = "cdk-serverlesstraining-imgbucket"
const resizedBucketId = imageBucketResourceId + "-resized"
const websiteBucketName = "cdk-rekn-publicbucket"


export class AwsServerlessTrainingStack extends cdk.Stack  {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // =====================================================================================
    // Image Bucket
    // =====================================================================================
    const imageBucket = new s3.Bucket(this, imageBucketResourceId, {
      removalPolicy: cdk.RemovalPolicy.DESTROY
    });
    new cdk.CfnOutput(this, 'imageBucket', { value: imageBucket.bucketName });
    const imageBucketArn = imageBucket.bucketArn;
    imageBucket.addCorsRule({
      allowedMethods: [HttpMethods.GET, HttpMethods.PUT],
      allowedOrigins: ["*"],
      allowedHeaders: ["*"],
      maxAge: 3000
    });

    // =====================================================================================
    // Thumbnail Bucket
    // =====================================================================================
    const resizedBucket = new s3.Bucket(this, resizedBucketId, {
      removalPolicy: cdk.RemovalPolicy.DESTROY
    });
    new cdk.CfnOutput(this, 'resizedBucket', { value: resizedBucket.bucketName });
    const resizedBucketArn = resizedBucket.bucketArn;
    resizedBucket.addCorsRule({
      allowedMethods: [HttpMethods.GET, HttpMethods.PUT],
      allowedOrigins: ["*"],
      allowedHeaders: ["*"],
      maxAge: 3000
    });

    // =====================================================================================
    // Construct to create our Amazon S3 Bucket to host our website
    // =====================================================================================
    const uiBucket = new s3.Bucket(this, websiteBucketName, {
      websiteIndexDocument: 'index.html',
      websiteErrorDocument: 'index.html',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      publicReadAccess: true, // comment if want to make it private
    });
    
    // Uncomment this  and add custom IP address to make it privates
    /*
    uiBucket.addToResourcePolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject'],
      resources: [uiBucket.arnForObjects('*')],
      principals: [new iam.AnyPrincipal()],
      conditions: {
        'IpAddress': {
          'aws:SourceIp': [ 
            '194.19.86.146/16' // Please change it to your IP address or from your allowed list
            ]
        }
      }
    }))
    */
   
    new cdk.CfnOutput(this, 'bucketURL', { value: uiBucket.bucketWebsiteDomainName });

    // =====================================================================================
    // Deploy site contents to S3 Bucket
    // =====================================================================================
    new s3deploy.BucketDeployment(this, 'DeployWebsite', {
      sources: [ s3deploy.Source.asset('./public') ],
      destinationBucket: uiBucket
    });


    // =====================================================================================
    // Amazon DynamoDB table for storing image labels
    // =====================================================================================
    const table = new dynamodb.Table(this, 'ImageLabels', {
      partitionKey: { name: 'image', type: dynamodb.AttributeType.STRING },
      removalPolicy: cdk.RemovalPolicy.DESTROY
    });
    new cdk.CfnOutput(this, 'ddbTable', { value: table.tableName });

    // =====================================================================================
    // Building our AWS Lambda Function; compute for our serverless microservice
    // =====================================================================================
    const layer = new lambda.LayerVersion(this, 'pil', {
      code: lambda.Code.fromAsset('reklayer'),
      compatibleRuntimes: [lambda.Runtime.PYTHON_3_7],
      license: 'Apache-2.0',
      description: 'A layer to enable the PIL library in our Rekognition lambda'
    });

    const sharpLayer = new lambda.LayerVersion(this, 'sharp-layer-', {
      compatibleRuntimes: [
        lambda.Runtime.NODEJS_14_X,
      ],
      code: lambda.Code.fromAsset('layer/sharp'),
      description: 'Uses a 3rd party library called Sharp to resize images',
    });

    // =====================================================================================
    // Building our AWS Lambda Function; compute for our serverless microservice
    // =====================================================================================
    /*
    const rekFn = new lambda.Function(this, 'rekognitionFunction', {
      code: lambda.Code.fromAsset('rekognitionlambda'),
      runtime: lambda.Runtime.PYTHON_3_7,
      handler: 'index.handler',
      timeout: Duration.seconds(30),
      memorySize: 1024,
      layers: [layer],
      environment: {
          "TABLE": table.tableName,
          "BUCKET": imageBucket.bucketName,
          "RESIZEDBUCKET": resizedBucket.bucketName
      },
    });*/

    const rekFn = new NodejsFunction(this, 'rekognitionFunction', {
      memorySize: 1024,
      timeout: cdk.Duration.seconds(30),
      runtime: lambda.Runtime.NODEJS_14_X,
      handler: 'handler',
      entry: path.join(__dirname, `../rekognitionlambda/index.ts`),
      environment: {
        "TABLE": table.tableName,
        "BUCKET": imageBucket.bucketName,
        "RESIZEDBUCKET": resizedBucket.bucketName,
      },
      /*
      bundling: {
        minify: false,
        externalModules: ['aws-sdk', 'sharp'],
      },*/
      layers: [sharpLayer],
    });

    // remove bucket creationn because labda is triggered now by the sqs queu
    // rekFn.addEventSource(new event_sources.S3EventSource(imageBucket, { events: [ s3.EventType.OBJECT_CREATED ]}));
    imageBucket.grantRead(rekFn);
    resizedBucket.grantPut(rekFn);
    table.grantWriteData(rekFn);
    
    rekFn.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['rekognition:DetectLabels'],
      resources: ['*']
    }));

    // =====================================================================================
    // Lambda for Synchronous Front End
    // =====================================================================================
    /*
  ​
    const serviceFn = new lambda.Function(this, 'serviceFunction', {
      //code: lambda.Code.fromAsset('servicelambda'),
      code: lambda.Code.fromAsset(path.join(__dirname, '../servicelambda')),
      // runtime: lambda.Runtime.PYTHON_3_7,
      runtime: lambda.Runtime.NODEJS_14_X,
      handler: 'index.handler',
      environment: {
        "TABLE": table.tableName,
        "BUCKET": imageBucket.bucketName,
        "RESIZEDBUCKET": resizedBucket.bucketName
      },
    });
    */

    const serviceFn = new NodejsFunction(this, 'serviceFunction', {
      memorySize: 1024,
      timeout: cdk.Duration.seconds(5),
      runtime: lambda.Runtime.NODEJS_14_X,
      handler: 'handler',
      entry: path.join(__dirname, `../servicelambda/index.ts`),
      environment: {
        "TABLE": table.tableName,
        "BUCKET": imageBucket.bucketName,
        "RESIZEDBUCKET": resizedBucket.bucketName,
      }
      /*
      bundling: {
        minify: true,
        externalModules: ['aws-sdk'],
      },
      */,
      
    });
    ​
    // define permisions
    imageBucket.grantReadWrite(serviceFn);
    resizedBucket.grantWrite(serviceFn);
    table.grantReadWriteData(serviceFn);

    const api = new apigw.LambdaRestApi(this, 'imageAPI', {
      defaultCorsPreflightOptions: {
        allowOrigins: apigw.Cors.ALL_ORIGINS,
        allowMethods: apigw.Cors.ALL_METHODS
      },
      handler: serviceFn,
      proxy: false,
    });

    // =====================================================================================
    // This construct builds a new Amazon API Gateway with AWS Lambda Integration
    // =====================================================================================
    const lambdaIntegration = new apigw.LambdaIntegration(serviceFn, {
      proxy: false,
      requestParameters: {
        'integration.request.querystring.action': 'method.request.querystring.action',
        'integration.request.querystring.key': 'method.request.querystring.key'
      },
      requestTemplates: {
        'application/json': JSON.stringify({ action: "$util.escapeJavaScript($input.params('action'))", key: "$util.escapeJavaScript($input.params('key'))" })
      },
      passthroughBehavior: PassthroughBehavior.WHEN_NO_TEMPLATES,
      integrationResponses: [
        {
          statusCode: "200",
          responseParameters: {
            // We can map response parameters
            // - Destination parameters (the key) are the response parameters (used in mappings)
            // - Source parameters (the value) are the integration response parameters or expressions
            'method.response.header.Access-Control-Allow-Origin': "'*'"
          }
        },
        {
          // For errors, we check if the error message is not empty, get the error data
          selectionPattern: "(\n|.)+",
          statusCode: "500",
          responseParameters: {
            'method.response.header.Access-Control-Allow-Origin': "'*'"
          }
        }
      ],
    });

    // =====================================================================================
    // Cognito User Pool Authentication
    // =====================================================================================
    const userPool = new cognito.UserPool(this, "UserPool", {
      selfSignUpEnabled: true, // Allow users to sign up
      autoVerify: { email: true }, // Verify email addresses by sending a verification code
      signInAliases: { username: true, email: true }, // Set email as an alias
    });

    const userPoolClient = new cognito.UserPoolClient(this, "UserPoolClient", {
      userPool,
      generateSecret: false, // Don't need to generate secret for web app running on browsers
    });

    const identityPool = new cognito.CfnIdentityPool(this, "ImageRekognitionIdentityPool", {
      allowUnauthenticatedIdentities: false, // Don't allow unathenticated users
      cognitoIdentityProviders: [
        {
        clientId: userPoolClient.userPoolClientId,
        providerName: userPool.userPoolProviderName,
        },
      ],
    });

    const auth = new apigw.CfnAuthorizer(this, 'APIGatewayAuthorizer', {
      name: 'customer-authorizer',
      identitySource: 'method.request.header.Authorization',
      providerArns: [userPool.userPoolArn],
      restApiId: api.restApiId,
      type: AuthorizationType.COGNITO,
    });

    const authenticatedRole = new iam.Role(this, "ImageRekognitionAuthenticatedRole", {
      assumedBy: new iam.FederatedPrincipal(
        "cognito-identity.amazonaws.com",
          {
          StringEquals: {
              "cognito-identity.amazonaws.com:aud": identityPool.ref,
          },
          "ForAnyValue:StringLike": {
            "cognito-identity.amazonaws.com:amr": "authenticated",
          },
        },
        "sts:AssumeRoleWithWebIdentity"
      ),
    });

     // IAM policy granting users permission to upload, download and delete their own pictures
     authenticatedRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "s3:GetObject",
          "s3:PutObject"
        ],
        effect: iam.Effect.ALLOW,
        resources: [
          imageBucketArn + "/private/${cognito-identity.amazonaws.com:sub}/*",
          imageBucketArn + "/private/${cognito-identity.amazonaws.com:sub}",
          resizedBucketArn + "/private/${cognito-identity.amazonaws.com:sub}/*",
          resizedBucketArn + "/private/${cognito-identity.amazonaws.com:sub}"
        ],
      })
    );

    // IAM policy granting users permission to list their pictures
    authenticatedRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["s3:ListBucket"],
        effect: iam.Effect.ALLOW,
        resources: [
          imageBucketArn,
          resizedBucketArn
        ],
        conditions: {"StringLike": {"s3:prefix": ["private/${cognito-identity.amazonaws.com:sub}/*"]}}
      })
    );

    new cognito.CfnIdentityPoolRoleAttachment(this, "IdentityPoolRoleAttachment", {
      identityPoolId: identityPool.ref,
      roles: { authenticated: authenticatedRole.roleArn },
    });

    // Export values of Cognito
    new CfnOutput(this, "UserPoolId", {
      value: userPool.userPoolId,
    });
    new CfnOutput(this, "AppClientId", {
      value: userPoolClient.userPoolClientId,
    });
    new CfnOutput(this, "IdentityPoolId", {
      value: identityPool.ref,
    });

    // =====================================================================================
    // API Gateway
    // =====================================================================================
    const imageAPI = api.root.addResource('images');
    ​
    // GET /images
    imageAPI.addMethod('GET', lambdaIntegration, {
      authorizationType: AuthorizationType.COGNITO,
      authorizer: { authorizerId: auth.ref },
      requestParameters: {
        'method.request.querystring.action': true,
        'method.request.querystring.key': true
      },
      methodResponses: [
        {
          statusCode: "200",
          responseParameters: {
            'method.response.header.Access-Control-Allow-Origin': true,
          },
        },
        {
          statusCode: "500",
          responseParameters: {
            'method.response.header.Access-Control-Allow-Origin': true,
          },
        }
      ]
    });
    
    // DELETE /images
    imageAPI.addMethod('DELETE', lambdaIntegration, {
      authorizationType: AuthorizationType.COGNITO,
      authorizer: { authorizerId: auth.ref },
      requestParameters: {
        'method.request.querystring.action': true,
        'method.request.querystring.key': true
      },
      methodResponses: [
        {
          statusCode: "200",
          responseParameters: {
            'method.response.header.Access-Control-Allow-Origin': true,
          },
        },
        {
          statusCode: "500",
          responseParameters: {
            'method.response.header.Access-Control-Allow-Origin': true,
          },
        }
      ]
    });

    // =====================================================================================
    // Building SQS queue and DeadLetter Queue
    // =====================================================================================
    const dlQueue = new sqs.Queue(this, 'ImageDLQueue', {
      // is noy a good practice to give it a name for scalability reason 
      
    })
    
    ​
    const queue = new sqs.Queue(this, 'ImageQueue', {
      visibilityTimeout: cdk.Duration.seconds(30),
      receiveMessageWaitTime: cdk.Duration.seconds(20),
      deadLetterQueue: {
        maxReceiveCount: 2,
        queue: dlQueue
      }
    });

    // =====================================================================================
    // Building S3 Bucket Create Notification to SQS
    // =====================================================================================
    imageBucket.addObjectCreatedNotification(new s3n.SqsDestination(queue), { prefix: 'private/' })
  
    // =====================================================================================
    // Lambda(Rekognition) to consume messages from SQS
    // =====================================================================================
    rekFn.addEventSource(new event_sources.SqsEventSource(queue));

  }
}
