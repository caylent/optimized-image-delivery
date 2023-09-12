'use strict';
import {GetObjectCommand, S3Client} from "@aws-sdk/client-s3";

const getAccount = (context) => {
    return context?.invokedFunctionArn?.split(":")[4] ?? "";
};

const getStackName = (context) => {
    return context?.invokedFunctionArn?.split(":")[6].split("-").slice(-1).shift() ?? "";
};
const s3AccessPoints = {
    "transformation-template=webp-20230802-460": {
        "arn": context => "arn:aws:s3-object-lambda:us-east-1:" + getAccount(context) + ":accesspoint/imgtransf11af8f-" + getStackName(context)
    },
    "transformation-template=webp-20230802-920": {
        "arn": context =>  "arn:aws:s3-object-lambda:us-east-1:" + getAccount(context) + ":accesspoint/imgtransf7a03bd-" + getStackName(context)
    }
};
const s3Client = new S3Client({
    region: "us-east-1",
    maxAttempts: 1,
    maxRetries: 0,
    httpOptions: {
        connectTimeout: 1500,
        timeout: 4600
    }
});

const toTransformation = queryString => {
    if (queryString?.indexOf("transformation-template=webp-20230802-460") >= 0) {
        return "transformation-template=webp-20230802-460";
    }

    if (queryString?.indexOf("transformation-template=webp-20230802-920") >= 0) {
        return "transformation-template=webp-20230802-920"
    }

    return undefined;
}

const setHeaders = (responseHeaders) => {
    // CloudFront caches for 90 secs because of the MinTTL/MaxTTL
    // Browser caches for a lot of time
    responseHeaders["cache-control"] = [{
        key: "Cache-Control",
        value: "max-age=630720000" + ", public" + ", immutable"
    }];
};

const getTransformedImage = (s3Key, requestedTransformation, context) => {
    console.info("Transformation '%s' requested for s3 key '%s'", requestedTransformation, s3Key);
    const transformedImage = {
        resizedImage: undefined,
        contentType: "image/webp"
    };
    const accessPoint = s3AccessPoints[requestedTransformation].arn(context);
    console.info("Access point: %s", accessPoint);
    return s3Client.send(new GetObjectCommand({
            Bucket: accessPoint,
            Key: s3Key
        })
    ).then(data => {
        const temp = {...data};
        temp.Body = "####";
        console.info("Got from S3 %j", temp);
        transformedImage.contentType = data.ContentType ?? "image/webp";
        return new Promise((resolve, reject) => {
            try {
                let responseDataChunks = [];
                data.Body.once("error", err => reject(err));
                data.Body.on("data", chunk => responseDataChunks.push(chunk));
                data.Body.once("end", () => {
                    transformedImage.resizedImage = Buffer.concat(responseDataChunks);
                    resolve(transformedImage);
                });
            } catch (err) {
                console.warn("Failed to read the response from Object Lambda", err);
                reject(err);
            }
        });
    });
};

const uriToS3Key = uriParts => [...uriParts.slice(1, -2), ...uriParts.slice(-1)].join("/");

export const handler = async (event, context) => {
    console.info("Event: %j", event);
    //Get contents of response
    const request = event.Records[0].cf.request;
    const response = event.Records[0].cf.response;
    const responseHeaders = response.headers;
    const {uri, querystring} = request;
    const decodedUri = decodeURIComponent(uri);
    // Confusing, while debugging found that it was a string but in the docs it's a number
    const responseStatus = Number.isInteger(response.status) ? response.status : parseInt(response.status);
    let requestedTransformation;
    let uriParts;

    if (responseStatus >= 200 && responseStatus <= 299) {
        setHeaders(responseHeaders);
    } else if (responseStatus === 403 &&
        (requestedTransformation = toTransformation(querystring)) &&
        (uriParts = decodedUri.split("/")).slice(-2).shift() === requestedTransformation) {
        try {
            const {resizedImage, contentType} = await getTransformedImage(uriToS3Key(uriParts), requestedTransformation, context);
            response.status = 200;
            response.body = resizedImage.toString("base64");
            response.bodyEncoding = "base64";
            if (contentType) {
                response.headers["content-type"] = [{key: "Content-Type", value: contentType}];
            }
            setHeaders(responseHeaders);
        } catch (e) {
            console.info("Failed to fetch/transform %s", decodedUri, e);
            response.status = 404;
            response.statusDescription = "Not Found";
        }
    } else if (responseStatus === 403) {
        // S3 answers with 403 instead of 404 because of the permissions between the services
        // So not having permissions to fetch an object and the object not existing will look the same
        response.status = 404;
        response.statusDescription = "Not Found";
    }

    return response;
};