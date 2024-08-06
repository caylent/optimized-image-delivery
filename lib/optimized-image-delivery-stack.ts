import * as cdk from 'aws-cdk-lib';
import {aws_s3objectlambda as s3objectlambda, Duration, Fn} from 'aws-cdk-lib';
import {
    AllowedMethods,
    BehaviorOptions,
    CachedMethods, CachePolicy, CacheQueryStringBehavior,
    CfnDistribution,
    CfnOriginAccessControl,
    Distribution,
    HttpVersion,
    IOrigin,
    LambdaEdgeEventType,
    OriginBindConfig,
    OriginRequestPolicy,
    PriceClass,
    SecurityPolicyProtocol,
    SSLMethod,
    ViewerProtocolPolicy
} from 'aws-cdk-lib/aws-cloudfront';
import {Construct} from 'constructs';
import {AaaaRecord, ARecord, IHostedZone, PublicHostedZone, RecordTarget} from "aws-cdk-lib/aws-route53";
import {DnsValidatedCertificate} from "aws-cdk-lib/aws-certificatemanager";
import {BlockPublicAccess, Bucket, CfnAccessPoint, HttpMethods} from "aws-cdk-lib/aws-s3";
import {
    AnyPrincipal,
    ArnPrincipal,
    CompositePrincipal,
    ManagedPolicy,
    PolicyDocument,
    PolicyStatement,
    Role,
    ServicePrincipal
} from "aws-cdk-lib/aws-iam";
import {CloudFrontTarget} from "aws-cdk-lib/aws-route53-targets";
import {NodejsFunction} from "aws-cdk-lib/aws-lambda-nodejs";
import {Architecture, Runtime} from "aws-cdk-lib/aws-lambda";
import {RetentionDays} from "aws-cdk-lib/aws-logs";
import * as path from 'path';

export interface OptimizedImageDeliveryStackProps extends cdk.StackProps {
    apexDomain: string;
    subdomain: string;
    stack: string;
}

export class OptimizedImageDeliveryStack extends cdk.Stack {
    readonly apexDomain: string;
    readonly subdomain: string;
    readonly stack: string;
    readonly imagesBucket: Bucket;
    private readonly _originResponseRef: string;

    constructor(scope: Construct, id: string, props: OptimizedImageDeliveryStackProps) {
        super(scope, id, props);
        this.apexDomain = props.apexDomain;
        this.subdomain = props.subdomain;
        this.stack = props.stack;
        this.imagesBucket = this.createImagesBucket();
        this._originResponseRef = `optimized-image-delivery-ori-res-${this.stack}`;

        const zone = PublicHostedZone.fromLookup(this, "ApexDomain", {
            domainName: this.apexDomain,
        });
        const distribution = this.createCloudfrontDistribution(zone);

        this.allowDistributionToReadS3Bucket(distribution);

        this.setS3BucketAsDefaultOrigin(distribution);

        this.createDnsRecordsForCloudfrontDistribution(distribution, zone);
    }

    private createDnsRecordsForCloudfrontDistribution(distribution: Distribution, zone: IHostedZone) {
        const target = RecordTarget.fromAlias(new CloudFrontTarget(distribution));
        new ARecord(this, 'ARecord', {
            recordName: `${this.subdomain}.${this.apexDomain}`,
            zone,
            target,
            ttl: Duration.hours(1),
            comment: `Optimized image delivery - '${this.stack}'`,
        });
        new AaaaRecord(this, 'AAAARecord', {
            recordName: `${this.subdomain}.${this.apexDomain}`,
            zone,
            target,
            ttl: Duration.hours(1),
            comment: `Optimized image delivery - '${this.stack}'`,
        });
    }

    private setS3BucketAsDefaultOrigin(distribution: Distribution) {
        // Need to use L1 construct for Origin Access Control
        const originAccessControl = new CfnOriginAccessControl(this, 'DefaultOriginAccessControl', {
            originAccessControlConfig: {
                name: `OptimizedImageDelivery-oac-${this.stack}`,
                originAccessControlOriginType: 's3',
                signingBehavior: 'always',
                signingProtocol: 'sigv4',
            },
        });
        const cfnDistribution = distribution.node.defaultChild as CfnDistribution;
        const distributionConfig = cfnDistribution.distributionConfig as any;
        distributionConfig.origins = [
            {
                domainName: this.imagesBucket.bucketRegionalDomainName,
                id: 'image-bucket',
                originAccessControlId: originAccessControl.attrId,
                s3OriginConfig: {}
            }
        ];
        distributionConfig.defaultCacheBehavior.targetOriginId = 'image-bucket';
    }

    private allowDistributionToReadS3Bucket(distribution: Distribution) {
        const bucketPolicy = new PolicyStatement();
        const {distributionId} = distribution;
        bucketPolicy.addActions('s3:GetObject');
        bucketPolicy.addServicePrincipal('cloudfront.amazonaws.com');
        bucketPolicy.addResources(`${this.imagesBucket.bucketArn}/*`);
        bucketPolicy.addCondition('StringEquals', {
            'AWS:SourceArn': Fn.sub("arn:aws:cloudfront::${AWS::AccountId}:distribution/${distributionId}", {
                distributionId
            })
        });
        this.imagesBucket.addToResourcePolicy(bucketPolicy);
    }

    private createCloudfrontDistribution(zone: IHostedZone) {
        const siteCertificate = new DnsValidatedCertificate(this, "WebsiteCertificate", {
            domainName: `${this.subdomain}.${this.apexDomain}`,
            hostedZone: zone,
            region: "us-east-1"  //standard for acm certs
        });

        const defaultBehaviorOptions: Pick<BehaviorOptions, "origin"> & Partial<BehaviorOptions> = {
            origin: {
                bind: () => ({} as OriginBindConfig)
            } as IOrigin, // because the S3Origin construct doesn't support Origin Access Control yet
        };
        const {standardAccessPoint, objectLambdaAccessPoint460, objectLambdaAccessPoint920, imageTransformationFunction} = this.createImageTransformationFunction();
        let originResponseFunctionRole;
        const distribution = new Distribution(this, "SiteDistribution", {
            domainNames: [`${this.subdomain}.${this.apexDomain}`],
            certificate: siteCertificate,
            errorResponses: [
                {
                    ttl: Duration.seconds(10),
                    httpStatus: 404,
                    responseHttpStatus: 404,
                    responsePagePath: "/index.html",
                },
                {
                    ttl: Duration.seconds(10),
                    httpStatus: 403,
                    responseHttpStatus: 403,
                    responsePagePath: "/index.html",
                }
            ],
            comment: 'Optimized image delivery blog post',
            priceClass: PriceClass.PRICE_CLASS_ALL,
            httpVersion: HttpVersion.HTTP2_AND_3,
            enableIpv6: true,
            sslSupportMethod: SSLMethod.SNI,
            minimumProtocolVersion: SecurityPolicyProtocol.TLS_V1_2_2021,
            defaultRootObject: "index.html",
            defaultBehavior: {
                ...defaultBehaviorOptions,
                viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                compress: true,
                allowedMethods: AllowedMethods.ALLOW_GET_HEAD,
                cachedMethods: CachedMethods.CACHE_GET_HEAD,
                cachePolicy: new CachePolicy(this, 'OptimizedImgDeliveryCachePolicy', {
                    maxTtl: Duration.seconds(90),
                    minTtl: Duration.seconds(5),
                    defaultTtl: Duration.seconds(10),
                    enableAcceptEncodingBrotli: true,
                    enableAcceptEncodingGzip: true,
                    queryStringBehavior: CacheQueryStringBehavior.allowList("transformation-template")
                }),
                originRequestPolicy: OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
                edgeLambdas: [
                    {
                        functionVersion: new NodejsFunction(this, 'OptimizedImgDeliveryOriginReqFunc', {
                            runtime: Runtime.NODEJS_18_X,
                            architecture: Architecture.X86_64,
                            timeout: Duration.seconds(7),
                            logRetention: RetentionDays.FIVE_DAYS,
                            functionName: `optimized-image-delivery-ori-req-${this.stack}`,
                            entry: path.join(__dirname, 'lambda@edge', 'origin.request.js'),
                            handler: 'handler',
                            memorySize: 128,
                            role: new Role(this, 'OptimizedImgDeliveryOriginReqRole', {
                                roleName: `optimized-image-delivery-ori-req-${this.stack}`,
                                assumedBy: new CompositePrincipal(new ServicePrincipal('edgelambda.amazonaws.com'), new ServicePrincipal('lambda.amazonaws.com')),
                                managedPolicies: [
                                    ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
                                ]
                            })
                        }).currentVersion,
                        eventType: LambdaEdgeEventType.ORIGIN_REQUEST
                    },
                    {
                        functionVersion: new NodejsFunction(this, 'OptimizedImgDeliveryOriginResFunc', {
                            runtime: Runtime.NODEJS_18_X,
                            architecture: Architecture.X86_64,
                            timeout: Duration.seconds(7),
                            logRetention: RetentionDays.FIVE_DAYS,
                            functionName: this._originResponseRef,
                            entry: path.join(__dirname, 'lambda@edge', 'origin.response.js'),
                            handler: 'handler',
                            memorySize: 128,
                            role: originResponseFunctionRole = new Role(this, 'OptimizedImgDeliveryOriginResRole', {
                                roleName: this._originResponseRef,
                                assumedBy: new CompositePrincipal(new ServicePrincipal('edgelambda.amazonaws.com'), new ServicePrincipal('lambda.amazonaws.com')),
                                managedPolicies: [
                                    ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
                                ],
                                inlinePolicies: {
                                    's3-access-point-read': new PolicyDocument({
                                        statements: [
                                            new PolicyStatement({
                                                actions: ['s3:GetObject', 's3:ListBucket'],
                                                resources: [
                                                    standardAccessPoint.attrArn,
                                                    `${standardAccessPoint.attrArn}/*`,
                                                ],
                                                conditions: {
                                                    'ForAnyValue:StringEquals': {
                                                        'aws:CalledVia': ['s3-object-lambda.amazonaws.com']
                                                    }
                                                }
                                            })
                                        ]
                                    }),
                                    's3-object-lambda-read': new PolicyDocument({
                                        statements: [
                                            new PolicyStatement({
                                                actions: ['s3-object-lambda:GetObject', 's3-object-lambda:ListBucket'],
                                                resources: [objectLambdaAccessPoint460.attrArn, objectLambdaAccessPoint920.attrArn]
                                            })
                                        ]
                                    })
                                }
                            })
                        }).currentVersion,
                        eventType: LambdaEdgeEventType.ORIGIN_RESPONSE
                    }
                ]
            },
        });

        imageTransformationFunction.addPermission('OriginResponseInvokePermission', {
            principal: originResponseFunctionRole,
        });

        return distribution;
    }

    private createImagesBucket() {
        return new Bucket(this, "ImagesBucket", {
            bucketName: `optimizedimagedelivery-a79b75-${this.stack}`,
            cors: [
                {
                    allowedMethods: [HttpMethods.GET, HttpMethods.HEAD],
                    allowedOrigins: ['*'],
                    allowedHeaders: ['*'],
                }
            ],
            versioned: false,
            blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
            lifecycleRules: [
                {
                    id: 'optimized-images-10d-ttl',
                    expiration: Duration.days(10),
                    tagFilters: {
                        'image:optimized': 'true'
                    }
                }
            ],
        });
    }

    private createImageTransformationFunction() {
        const role = new Role(this, 'ImageTransformationRole', {
            roleName: `image-transform-${this.stack}`,
            assumedBy: new CompositePrincipal(new ServicePrincipal('edgelambda.amazonaws.com'), new ServicePrincipal('lambda.amazonaws.com')),
            managedPolicies: [
                ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
            ]
        });

        const imageTransformationFunction = new NodejsFunction(this, 'ImageTransformationFunc', {
            runtime: Runtime.NODEJS_18_X,
            architecture: Architecture.X86_64,
            timeout: Duration.seconds(40),
            logRetention: RetentionDays.TWO_MONTHS,
            functionName: `image-transform-${this.stack}`,
            entry: path.join(__dirname, 'lambda', 'image-transform.js'),
            handler: 'handler',
            memorySize: 10240,
            role,
            initialPolicy: [
                new PolicyStatement({
                    actions: ['s3:PutObject', 's3:PutObjectTagging'],
                    resources: [`arn:aws:s3:::${this.imagesBucket.bucketName}/*`],
                })
            ],
            bundling: {
                forceDockerBundling: true,
                nodeModules: ['sharp']
            },
            environment: {
                BUCKET_NAME: this.imagesBucket.bucketName,
            }
        });

        const standardAccessPoint = new CfnAccessPoint(this, 'ImageTransformAccessPoint', {
            bucket: this.imagesBucket.bucketName,
            name: `image-transform-${this.stack}`,
            publicAccessBlockConfiguration: {
                blockPublicAcls: true,
                blockPublicPolicy: true,
                ignorePublicAcls: true,
                restrictPublicBuckets: true
            }
        });
        this.imagesBucket.addToResourcePolicy(new PolicyStatement({
            actions: ['s3:GetObject', 's3:ListBucket'],
            resources: [this.imagesBucket.bucketArn, `${this.imagesBucket.bucketArn}/*`],
            principals: [new ArnPrincipal(`arn:aws:iam::${this.account}:role/${this._originResponseRef}`)],
            conditions: {
                'StringEquals': {
                    's3:DataAccessPointArn': standardAccessPoint.attrArn
                }
            }
        }));
        const objectLambdaAccessPoint460 = new s3objectlambda.CfnAccessPoint(this, 'ImgTransAccessPoint460', {
            objectLambdaConfiguration: {
                supportingAccessPoint: standardAccessPoint.attrArn,
                transformationConfigurations: [{
                    actions: ['GetObject'],
                    contentTransformation: {
                        "AwsLambda": {
                            "FunctionArn": imageTransformationFunction.functionArn,
                            "FunctionPayload": "webp-20230802-460"
                        }
                    }
                }],
                allowedFeatures: ['GetObject-Range', 'GetObject-PartNumber'],
                cloudWatchMetricsEnabled: false,
            },
            name: `imgtransf11af8f-${this.stack}`,
        });
        const objectLambdaAccessPoint920 = new s3objectlambda.CfnAccessPoint(this, 'ImgTransAccessPoint920', {
            objectLambdaConfiguration: {
                supportingAccessPoint: standardAccessPoint.attrArn,
                transformationConfigurations: [{
                    actions: ['GetObject'],
                    contentTransformation: {
                        "AwsLambda": {
                            "FunctionArn": imageTransformationFunction.functionArn,
                            "FunctionPayload": "webp-20230802-920"
                        }
                    }
                }],
                allowedFeatures: ['GetObject-Range', 'GetObject-PartNumber'],
                cloudWatchMetricsEnabled: false,
            },
            name: `imgtransf7a03bd-${this.stack}`,
        });
        role.addToPolicy(new PolicyStatement({
            actions: ['s3-object-lambda:WriteGetObjectResponse'],
            resources: [
                `arn:aws:s3-object-lambda:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:accesspoint/imgtransf11af8f-${this.stack}`,
                `arn:aws:s3-object-lambda:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:accesspoint/imgtransf7a03bd-${this.stack}`
            ],
        }));

        return {standardAccessPoint, objectLambdaAccessPoint460, objectLambdaAccessPoint920, imageTransformationFunction};
    }
}
