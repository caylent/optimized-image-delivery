export const handler = async event => {
    return event.Records[0].cf.response;
};