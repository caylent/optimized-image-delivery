const sharp = require("sharp");
const https = require("https");
const Stream = require("stream");
const S3 = require("aws-sdk/clients/s3");
const s3 = new S3({
    apiVersion: "2006-03-01",
    region: "us-east-1",
    maxRetries: 1,
    httpOptions: {
        timeout: 4000
    }
});

const transformationTemplates = {
    "webp-20230802-460": {
        "transform": s => s.metadata()
            .then(metadata => {
                const orientation = metadata.orientation;
                let optimizedImage = s
                    .trim()
                    .resize({
                        width: 460,
                        fit: 'cover',
                        withoutEnlargement: true
                    })
                    .webp({
                        reductionEffort: 6,
                        quality: 60
                    });

                if (orientation === 8) {
                    optimizedImage = optimizedImage.rotate();
                } else if (orientation === 3) {
                    optimizedImage = optimizedImage.rotate().rotate();
                } else if (orientation === 6) {
                    optimizedImage = optimizedImage.rotate().rotate().rotate();
                }

                return optimizedImage;
            }),
        "contentType": "image/webp"
    },
    "webp-20230802-920": {
        "transform": s => s.metadata()
            .then(metadata => {
                const orientation = metadata.orientation;
                let optimizedImage = s
                    .trim()
                    .resize({
                        width: 920,
                        fit: 'cover',
                        withoutEnlargement: true
                    })
                    .webp({
                        reductionEffort: 6,
                        quality: 60
                    });

                if (orientation === 8) {
                    optimizedImage = optimizedImage.rotate();
                } else if (orientation === 3) {
                    optimizedImage = optimizedImage.rotate().rotate();
                } else if (orientation === 6) {
                    optimizedImage = optimizedImage.rotate().rotate().rotate();
                }

                return optimizedImage;
            }),
        "contentType": "image/webp"
    }
};

const fetchObject = (signedUrl) =>
    new Promise((resolve, reject) => {
        https.get(signedUrl, (res) => {
            console.info("S3 - statusCode:", res.statusCode);
            console.info("S3 - headers:", res.headers);

            if (res.statusCode !== 200) {
                reject("Fetch didn't come back as a HTTP 200");
                return;
            }

            const data = new Stream.Transform();
            res.on("data", chunk => {
                data.push(chunk);
            });
            res.on("end", () => {
                resolve({
                    Body: data.read(),
                    ContentType: res.headers["content-type"]
                });
            });
        }).on("error", (e) => {
            console.error("Failed to fetch signed URL", e);
            reject(e);
        }).end();
    });

const resize = async (imageData, transformation) =>
    (await transformationTemplates[transformation].transform(sharp(imageData)))
        .toBuffer();

const putImageInResponse = (resizedImage, objectContext, contentType) =>
    s3.writeGetObjectResponse({
        Body: resizedImage,
        RequestRoute: objectContext.outputRoute,
        RequestToken: objectContext.outputToken,
        ContentType: contentType
    }).promise().then(() => {
        console.info("Invoked s3.writeGetObjectResponse() successfully");
    });

const resizedImageS3Data = (url, transformation) => {
    const urlParts = decodeURIComponent(url).split("/");

    return {
        resizedImageS3Key: [...urlParts.slice(3, -1), ("transformation-template=" + transformation), urlParts.slice(-1).shift().split("?").shift()].join("/"),
        resizedImageS3Tags: "image:optimized=true"
    };
};

const saveResizedImage = (resizedImage, resizedImageS3Key, contentType, resizedImageS3Tags) => {
    const params = {
        Body: resizedImage,
        Bucket: process.env.BUCKET_NAME,
        StorageClass: "STANDARD",
        ContentType: contentType,
        Key: resizedImageS3Key
    };

    if (resizedImageS3Tags) {
        params.Tagging = resizedImageS3Tags;
    }

    return s3.putObject(params).promise().then(() => {
        console.info("Saved the resized image");
    }).catch(e => {
        console.warn("Failed to save a resized image", e);
    });
};

exports.handler = async (event) => {
    console.info("Received: ", event);
    const transformation = event.configuration.payload;
    const uber = {};
    try {
        Object.assign(uber, resizedImageS3Data(event.userRequest.url, transformation));
    } catch (e) {
        console.error(e);
        return {"status_code": 404};
    }
    const {resizedImageS3Key, resizedImageS3Tags} = uber;

    let imageData;
    try {
        imageData = await fetchObject(event.getObjectContext.inputS3Url);
    } catch (e) {
        console.error(e);
        return {"status_code": 404};
    }

    try {
        const resizedImage = await resize(imageData.Body, transformation);
        const contentType = transformationTemplates[transformation].contentType ?? imageData.ContentType;
        await putImageInResponse(resizedImage, event.getObjectContext, contentType);
        await saveResizedImage(resizedImage, resizedImageS3Key, contentType, resizedImageS3Tags);
    } catch (e) {
        console.error(e);
        return {"status_code": 403}
    }

    return {"status_code": 200}
};