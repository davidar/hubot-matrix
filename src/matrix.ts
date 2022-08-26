import { Robot, Adapter, TextMessage, Envelope } from "hubot";
import {
  ClientEvent,
  MatrixClient,
  RoomEvent,
  RoomMemberEvent,
} from "matrix-js-sdk";

import sdk from "matrix-js-sdk";
import request from "request";
import sizeOf from "image-size";

/**
 * The Matrix-specific metadata available about a message.
 */
export type MatrixMessageMetadata = {
  readonly threadId: string;
};

/**
 * Represents a regular Hubot TextMessage with additional Matrix metadata.
 */
export class MatrixMessage extends TextMessage {
  constructor(
    user: User,
    text: string,
    id: string,
    public metadata: MatrixMessageMetadata
  ) {
    super(user, text, id);
  }
}

class Matrix extends Adapter {
  private client: MatrixClient | undefined;
  private user_id: string | undefined;
  private access_token: string | undefined;
  private device_id: string | undefined;

  constructor(private robot: Robot<Matrix>) {
    super(robot);
    this.robot.logger.info("Constructor");
  }

  handleUnknownDevices(err: { devices: { [x: string]: any } }) {
    return (() => {
      let result = [];
      for (var stranger in err.devices) {
        var devices = err.devices[stranger];
        result.push(
          (() => {
            let result1 = [];
            for (let device in devices) {
              this.robot.logger.info(
                `Acknowledging ${stranger}'s device ${device}`
              );
              result1.push(this.client.setDeviceKnown(stranger, device));
            }
            return result1;
          })()
        );
      }
      return result;
    })();
  }

  send(envelope: Envelope, ...strings: any[]) {
    return (() => {
      let result = [];
      for (var str of Array.from(strings)) {
        this.robot.logger.info(`Sending to ${envelope.room}: ${str}`);
        if (/^(f|ht)tps?:\/\//i.test(str)) {
          result.push(this.sendURL(envelope, str));
        } else {
          result.push(
            this.client.sendNotice(envelope.room, str).catch((err) => {
              if (err.name === "UnknownDeviceError") {
                this.handleUnknownDevices(err);
                return this.client.sendNotice(envelope.room, str);
              }
            })
          );
        }
      }
      return result;
    })();
  }

  emote(envelope: Envelope, ...strings: string[]) {
    return Array.from(strings).map((str) =>
      this.client.sendEmoteMessage(envelope.room, str).catch((err) => {
        if (err.name === "UnknownDeviceError") {
          this.handleUnknownDevices(err);
          return this.client.sendEmoteMessage(envelope.room, str);
        }
      })
    );
  }

  reply(envelope: Envelope, ...strings: string[]) {
    return Array.from(strings).map((str) =>
      this.send(envelope, `${envelope.user.name}: ${str}`)
    );
  }

  topic(envelope: Envelope, ...strings: string[]) {
    return Array.from(strings).map((str) =>
      this.client.sendStateEvent(
        envelope.room,
        "m.room.topic",
        {
          topic: str,
        },
        ""
      )
    );
  }

  sendURL(envelope: Envelope, url: string) {
    this.robot.logger.info(`Downloading ${url}`);
    return request({ url, encoding: null }, (error, response, body) => {
      if (error) {
        return this.robot.logger.info(
          `Request error: ${JSON.stringify(error)}`
        );
      } else if (response.statusCode === 200) {
        let info: sdk.IImageInfo;
        try {
          let dims = sizeOf(body);
          this.robot.logger.info(
            `Image has dimensions ${JSON.stringify(dims)}, size ${body.length}`
          );
          if (dims.type === "jpg") {
            dims.type = "jpeg";
          }
          info = {
            mimetype: `image/${dims.type}`,
            h: dims.height,
            w: dims.width,
            size: body.length,
          };
          return this.client
            .uploadContent(body, {
              name: url,
              type: info.mimetype,
              rawResponse: false,
              onlyContentUri: true,
            })
            .then((content_uri) => {
              return this.client
                .sendImageMessage(envelope.room, content_uri, info, url)
                .catch((err) => {
                  if (err.name === "UnknownDeviceError") {
                    this.handleUnknownDevices(err);
                    return this.client.sendImageMessage(
                      envelope.room,
                      content_uri,
                      info,
                      url
                    );
                  }
                });
            });
        } catch (error1) {
          error = error1;
          this.robot.logger.info(error.message);
          return this.send(envelope, ` ${url}`);
        }
      }
    });
  }

  run() {
    this.robot.logger.info(`Run ${this.robot.name}`);
    let client = sdk.createClient({
      baseUrl: process.env.HUBOT_MATRIX_HOST_SERVER || "https://matrix.org",
      request: request,
    });
    return client.login(
      "m.login.password",
      {
        user: process.env.HUBOT_MATRIX_USER || this.robot.name,
        password: process.env.HUBOT_MATRIX_PASSWORD,
      },
      (
        err: any,
        data: { user_id: string; access_token: string; device_id: string }
      ) => {
        if (err) {
          this.robot.logger.error(err);
          return;
        }
        this.user_id = data.user_id;
        this.access_token = data.access_token;
        this.device_id = data.device_id;
        this.robot.logger.info(
          `Logged in ${this.user_id} on device ${this.device_id}`
        );
        this.client = sdk.createClient({
          baseUrl: process.env.HUBOT_MATRIX_HOST_SERVER || "https://matrix.org",
          accessToken: this.access_token,
          userId: this.user_id,
          deviceId: this.device_id,
          request,
        });
        this.client.on(ClientEvent.Sync, (state) => {
          switch (state) {
            case "PREPARED":
              this.robot.logger.info(
                `Synced ${this.client.getRooms().length} rooms`
              );
              // We really don't want to let people set the display name to something other than the bot
              // name because the bot only reacts to it's own name.
              const currentDisplayName = this.client.getUser(
                this.user_id
              ).displayName;
              if (this.robot.name !== currentDisplayName) {
                this.robot.logger.info(
                  `Setting display name to ${this.robot.name}`
                );
                this.client.setDisplayName(this.robot.name, () => {});
              }
              return this.emit("connected");
          }
        });
        this.client.on(RoomEvent.Timeline, (event, room, toStartOfTimeline) => {
          if (
            event.getType() === "m.room.message" &&
            toStartOfTimeline === false
          ) {
            this.client.setPresence({ presence: "online" });
            let id = event.getId();
            let message = event.getContent();
            let name = event.getSender();
            let user = this.robot.brain.userForId(name);
            user.room = room.roomId;
            if (name !== this.user_id) {
              this.robot.logger.info(
                `Received message: ${JSON.stringify(message)} in room: ${
                  user.room
                }, from: ${user.name} (${user.id}).`
              );
              if (message.msgtype === "m.text") {
                const messageThreadId = event.threadRootId ?? id;

                this.receive(
                  new MatrixMessage(user, message.body, id, {
                    threadId: messageThreadId,
                  })
                );
              }
              if (
                message.msgtype !== "m.text" ||
                message.body.indexOf(this.robot.name) !== -1
              ) {
                return this.client.sendReadReceipt(event);
              }
            }
          }
        });
        this.client.on(RoomMemberEvent.Membership, async (event, member) => {
          if (
            member.membership === "invite" &&
            member.userId === this.user_id
          ) {
            await this.client.joinRoom(member.roomId);
            this.robot.logger.info(`Auto-joined ${member.roomId}`);
          }
        });
        return this.client.startClient({ initialSyncLimit: 0 });
      }
    );
  }
}

export default function (robot: Robot<any>): Matrix {
  return new Matrix(robot);
}
