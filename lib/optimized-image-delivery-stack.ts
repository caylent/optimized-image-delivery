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
    OriginBindConfig,
    PriceClass,
    SecurityPolicyProtocol,
    SSLMethod,
    ViewerProtocolPolicy
} from 'aws-cdk-lib/aws-cloudfront';
import {Construct} from 'constructs';
import {AaaaRecord, ARecord, PublicHostedZone, RecordTarget} from "aws-cdk-lib/aws-route53";
import {DnsValidatedCertificate} from "aws-cdk-lib/aws-certificatemanager";
import {BlockPublicAccess, Bucket, HttpMethods} from "aws-cdk-lib/aws-s3";
import {PolicyStatement} from "aws-cdk-lib/aws-iam";
import {CloudFrontTarget} from "aws-cdk-lib/aws-route53-targets";

export interface OptimizedImageDeliveryStackProps extends cdk.StackProps {
    apexDomain: string;
    subdomain: string;
    stackId: string;
}

export class OptimizedImageDeliveryStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: OptimizedImageDeliveryStackProps) {
        super(scope, id, props);
        const {apexDomain, subdomain, stackId} = props;

        const imageBucket: Bucket = new Bucket(this, "ImagesBucket", {
            bucketName: `optimizedimagedelivery-a79b75-${stackId}`,
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

        const zone = PublicHostedZone.fromLookup(this, "ApexDomain", {
            domainName: apexDomain,
        });

        const siteCertificate = new DnsValidatedCertificate(this, "WebsiteCertificate", {
            domainName: `${subdomain}.${apexDomain}`,
            hostedZone: zone,
            region: "us-east-1"  //standard for acm certs
        });

        const defaultBehaviorOptions: Pick<BehaviorOptions, "origin"> & Partial<BehaviorOptions> = {
            origin: {
                bind: () => ({} as OriginBindConfig)
            } as IOrigin, // because the S3Origin construct doesn't support Origin Access Control yet
        };

        const distribution = new Distribution(this, "SiteDistribution", {
            domainNames: [`${subdomain}.${apexDomain}`],
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
                cachedMethods: CachedMethods.CACHE_GET_HEAD
            },
        });

        const bucketPolicy = new PolicyStatement();
        const {distributionId} = distribution;
        bucketPolicy.addActions('s3:GetObject');
        bucketPolicy.addServicePrincipal('cloudfront.amazonaws.com');
        bucketPolicy.addResources(`${imageBucket.bucketArn}/*`);
        bucketPolicy.addCondition('StringEquals', {
            'AWS:SourceArn': Fn.sub("arn:aws:cloudfront::${AWS::AccountId}:distribution/${distributionId}", {
                distributionId
            })
        });
        imageBucket.addToResourcePolicy(bucketPolicy);

        // Need to use L1 construct for Origin Access Control
        const originAccessControl = new CfnOriginAccessControl(this, 'DefaultOriginAccessControl', {
            originAccessControlConfig: {
                name: `OptimizedImageDelivery-oac-${stackId}`,
                originAccessControlOriginType: 's3',
                signingBehavior: 'always',
                signingProtocol: 'sigv4',
            },
        });
        const cfnDistribution = distribution.node.defaultChild as CfnDistribution;
        const distributionConfig = cfnDistribution.distributionConfig as any;
        distributionConfig.origins = [
            {
                domainName: imageBucket.bucketRegionalDomainName,
                id: 'image-bucket',
                originAccessControlId: originAccessControl.attrId,
                s3OriginConfig: {}
            }
        ];
        distributionConfig.defaultCacheBehavior.targetOriginId = 'image-bucket';

        const target = RecordTarget.fromAlias(new CloudFrontTarget(distribution));
        new ARecord(this, 'ARecord', {
            recordName: `${subdomain}.${apexDomain}`,
            zone,
            target,
            ttl: Duration.hours(1),
            comment: `Optimized image delivery - '${stackId}'`,
        });
        new AaaaRecord(this, 'AAAARecord', {
            recordName: `${subdomain}.${apexDomain}`,
            zone,
            target,
            ttl: Duration.hours(1),
            comment: `Optimized image delivery - '${stackId}'`,
        });
    }
}
