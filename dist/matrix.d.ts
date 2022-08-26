import { Robot, Adapter, Envelope, TextMessage, User } from "hubot";
import sdk from "matrix-js-sdk";
import request from "request";
/**
 * The Matrix-specific metadata available about a message.
 */
export declare type MatrixMessageMetadata = {
    readonly threadId: string;
};
/**
 * Represents a regular Hubot TextMessage with additional Matrix metadata.
 */
export declare class MatrixMessage extends TextMessage {
    metadata: MatrixMessageMetadata;
    constructor(user: User, text: string, id: string, metadata: MatrixMessageMetadata);
}
declare class Matrix extends Adapter {
    private robot;
    private client;
    private user_id;
    private access_token;
    private device_id;
    constructor(robot: Robot<Matrix>);
    handleUnknownDevices(err: {
        devices: {
            [x: string]: any;
        };
    }): (Promise<void> | undefined)[][];
    send(envelope: Envelope, ...strings: any[]): any;
    sendThreaded(envelope: Envelope, threadId: string | undefined, message: string): any;
    emote(envelope: Envelope, ...strings: string[]): (Promise<sdk.ISendEventResponse | undefined> | undefined)[];
    reply(envelope: Envelope, ...strings: string[]): any[];
    topic(envelope: Envelope, ...strings: string[]): (Promise<sdk.ISendEventResponse> | undefined)[];
    sendURL(envelope: Envelope, url: string): request.Request;
    run(): Promise<any>;
}
export declare function use(robot: Robot<any>): Matrix;
export {};
