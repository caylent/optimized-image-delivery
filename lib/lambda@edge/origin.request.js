'use strict';

const toTransformation = queryString => {
    if (queryString?.indexOf("transformation-template=webp-20230802-460") >= 0) {
        return "/transformation-template=webp-20230802-460/";
    }

    if (queryString?.indexOf("transformation-template=webp-20230802-920") >= 0) {
        return "/transformation-template=webp-20230802-920/"
    }

    return undefined;
}

export const handler = async event => {
    const cfrequest = event.Records[0].cf.request;
    const {uri, querystring} = cfrequest;
    const uriParts = decodeURIComponent(uri.slice(1)).split("/");

    const requestedTransformation = toTransformation(querystring);

    if (requestedTransformation) {
        cfrequest.uri = encodeURI(uriParts.slice(0, -1).join("/") + requestedTransformation + uriParts.slice(-1).shift());
    }
    console.debug(cfrequest.uri);
    return cfrequest;
};