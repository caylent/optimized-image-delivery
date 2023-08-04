import * as cdk from 'aws-cdk-lib';
import {Duration, Fn} from 'aws-cdk-lib';
import {
    AllowedMethods,
    BehaviorOptions,
    CachedMethods,
    CfnDistribution,
    CfnOriginAccessControl,
    Distribution,
    HttpVersion,
    IOrigin,
    LambdaEdgeEventType,
    OriginBindConfig,
    PriceClass,
    SecurityPolicyProtocol,
    SSLMethod,
    ViewerProtocolPolicy
} from 'aws-cdk-lib/aws-cloudfront';
import {Construct} from 'constructs';
import {AaaaRecord, ARecord, IHostedZone, PublicHostedZone, RecordTarget} from "aws-cdk-lib/aws-route53";
import {DnsValidatedCertificate} from "aws-cdk-lib/aws-certificatemanager";
import {BlockPublicAccess, Bucket, HttpMethods} from "aws-cdk-lib/aws-s3";
import {CompositePrincipal, ManagedPolicy, PolicyStatement, Role, ServicePrincipal} from "aws-cdk-lib/aws-iam";
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

    constructor(scope: Construct, id: string, props: OptimizedImageDeliveryStackProps) {
        super(scope, id, props);
        this.apexDomain = props.apexDomain;
        this.subdomain = props.subdomain;
        this.stack = props.stack;

        const imagesBucket: Bucket = this.imagesBucket();

        const zone = PublicHostedZone.fromLookup(this, "ApexDomain", {
            domainName: this.apexDomain,
        });
        const distribution = this.createCloudfrontDistribution(zone);

        this.allowDistributionToReadS3Bucket(distribution, imagesBucket);

        this.setS3BucketAsDefaultOrigin(distribution, imagesBucket);

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

    private setS3BucketAsDefaultOrigin(distribution: Distribution, imagesBucket: Bucket) {
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
                domainName: imagesBucket.bucketRegionalDomainName,
                id: 'image-bucket',
                originAccessControlId: originAccessControl.attrId,
                s3OriginConfig: {}
            }
        ];
        distributionConfig.defaultCacheBehavior.targetOriginId = 'image-bucket';
    }

    private allowDistributionToReadS3Bucket(distribution: Distribution, imagesBucket: Bucket) {
        const bucketPolicy = new PolicyStatement();
        const {distributionId} = distribution;
        bucketPolicy.addActions('s3:GetObject');
        bucketPolicy.addServicePrincipal('cloudfront.amazonaws.com');
        bucketPolicy.addResources(`${imagesBucket.bucketArn}/*`);
        bucketPolicy.addCondition('StringEquals', {
            'AWS:SourceArn': Fn.sub("arn:aws:cloudfront::${AWS::AccountId}:distribution/${distributionId}", {
                distributionId
            })
        });
        imagesBucket.addToResourcePolicy(bucketPolicy);
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

        return new Distribution(this, "SiteDistribution", {
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
                edgeLambdas: [
                    {
                        functionVersion: new NodejsFunction(this, 'OptimizedImageDeliveryFunc', {
                            runtime: Runtime.NODEJS_18_X,
                            architecture: Architecture.X86_64,
                            timeout: Duration.seconds(7),
                            logRetention: RetentionDays.FIVE_DAYS,
                            functionName: `optimized-img-delivery-ori-req-${this.stack}`,
                            entry: path.join(__dirname, 'lambda@edge', 'origin.request.js'),
                            handler: 'handler',
                            memorySize: 128,
                            role: new Role(this, 'OptimizedImgDeliveryOriReqRole', {
                                roleName: `optimized-img-delivery-ori-req-${this.stack}`,
                                assumedBy: new CompositePrincipal(new ServicePrincipal('edgelambda.amazonaws.com'), new ServicePrincipal('lambda.amazonaws.com')),
                                managedPolicies: [
                                    ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
                                ]
                            })
                        }).currentVersion,
                        eventType: LambdaEdgeEventType.ORIGIN_REQUEST
                    },
                ]
            },
        });
    }

    private imagesBucket() {
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
        });
    }
}
