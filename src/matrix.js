let Adapter, localStorage, Robot, TextMessage, User;
try {
  ({Robot,Adapter,TextMessage,User} = require('hubot'));
} catch (error) {
  let prequire = require('parent-require');
  ({Robot,Adapter,TextMessage,User} = prequire('hubot'));
}

let sdk = require('matrix-js-sdk');
let request = require('request');
let sizeOf = require('image-size');

if (localStorage == null) {
  let {LocalStorage} = require('node-localstorage');
  localStorage = new LocalStorage('./hubot-matrix.localStorage');
}

class Matrix extends Adapter {
  constructor() {
    super(...arguments);
    this.robot.logger.info("Constructor");
  }

  handleUnknownDevices(err) {
    return (() => {
      let result = [];
      for (var stranger in err.devices) {
        var devices = err.devices[stranger];
        result.push((() => {
          let result1 = [];
          for (let device in devices) {
            let _ = devices[device];
            this.robot.logger.info(`Acknowledging ${stranger}'s device ${device}`);
            result1.push(this.client.setDeviceKnown(stranger, device));
          }
          return result1;
        })());
      }
      return result;
    })();
  }

  send(envelope, ...strings) {
    return (() => {
      let result = [];
      for (var str of Array.from(strings)) {
        this.robot.logger.info(`Sending to ${envelope.room}: ${str}`);
        if (/^(f|ht)tps?:\/\//i.test(str)) {
          result.push(this.sendURL(envelope, str));
        } else {
          result.push(this.client.sendNotice(envelope.room, str).catch(err => {
            if (err.name === 'UnknownDeviceError') {
              this.handleUnknownDevices(err);
              return this.client.sendNotice(envelope.room, str);
            }
          }));
        }
      }
      return result;
    })();
  }

  emote(envelope, ...strings) {
    return Array.from(strings).map((str) =>
      this.client.sendEmoteMessage(envelope.room, str).catch(err => {
        if (err.name === 'UnknownDeviceError') {
          this.handleUnknownDevices(err);
          return this.client.sendEmoteMessage(envelope.room, str);
        }
      }));
  }

  reply(envelope, ...strings) {
    return Array.from(strings).map((str) =>
      this.send(envelope, `${envelope.user.name}: ${str}`));
  }

  topic(envelope, ...strings) {
    return Array.from(strings).map((str) =>
      this.client.sendStateEvent(envelope.room, "m.room.topic", {
        topic: str
      }, ""));
  }

  sendURL(envelope, url) {
    this.robot.logger.info(`Downloading ${url}`);
    return request({url, encoding: null}, (error, response, body) => {
      if (error) {
        return this.robot.logger.info(`Request error: ${JSON.stringify(error)}`);
      } else if (response.statusCode === 200) {
        let info;
        try {
          let dims = sizeOf(body);
          this.robot.logger.info(`Image has dimensions ${JSON.stringify(dims)}, size ${body.length}`);
          if (dims.type === 'jpg') { dims.type = 'jpeg'; }
          info = { mimetype: `image/${dims.type}`, h: dims.height, w: dims.width, size: body.length };
          return this.client.uploadContent(body, {name: url, type: info.mimetype, rawResponse: false, onlyContentUri: true}).done(content_uri => {
            return this.client.sendImageMessage(envelope.room, content_uri, info, url).catch(err => {
              if (err.name === 'UnknownDeviceError') {
                this.handleUnknownDevices(err);
                return this.client.sendImageMessage(envelope.room, content_uri, info, url);
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
    let client = sdk.createClient(process.env.HUBOT_MATRIX_HOST_SERVER || 'https://matrix.org');
    this.robot.matrixClient = client;
    return client.login('m.login.password', {
      user: this.robot.name,
      password: process.env.HUBOT_MATRIX_PASSWORD
    }, (err, data) => {
        if (err) {
            this.robot.logger.error(err);
            return;
        }
        this.user_id = data.user_id;
        this.access_token = data.access_token;
        this.device_id = data.device_id;
        this.robot.logger.info(`Logged in ${this.user_id} on device ${this.device_id}`);
        this.client = sdk.createClient({
            baseUrl: process.env.HUBOT_MATRIX_HOST_SERVER || 'https://matrix.org',
            accessToken: this.access_token,
            userId: this.user_id,
            deviceId: this.device_id,
            sessionStore: new sdk.WebStorageSessionStore(localStorage)
        });
        this.client.on('sync', (state, prevState, data) => {
            switch (state) {
              case "PREPARED":
                this.robot.logger.info(`Synced ${this.client.getRooms().length} rooms`);
                return this.emit('connected');
            }
        });
        this.client.on('Room.timeline', (event, room, toStartOfTimeline) => {
            if ((event.getType() === 'm.room.message') && (toStartOfTimeline === false)) {
                this.client.setPresence("online");
                let message = event.getContent();
                let name = event.getSender();
                let prettyname = room.currentState._userIdsToDisplayNames[name];
                let user = this.robot.brain.userForId(name, { name: prettyname });
                user.room = room.roomId;
                if (user.name !== this.user_id) {
                    this.robot.logger.info(`Received message: ${JSON.stringify(message)} in room: ${user.room}, from: ${user.name}.`);
                    if (message.msgtype === "m.text") { this.receive(new TextMessage(user, message.body)); }
                    if ((message.msgtype !== "m.text") || (message.body.indexOf(this.robot.name) !== -1)) { return this.client.sendReadReceipt(event); }
                  }
              }
        });
        this.client.on('RoomMember.membership', (event, member) => {
            if ((member.membership === 'invite') && (member.userId === this.user_id)) {
                return this.client.joinRoom(member.roomId).done(() => {
                    return this.robot.logger.info(`Auto-joined ${member.roomId}`);
                });
              }
        });
        return this.client.startClient(0);
    });
  }
}

module.exports.use = (robot) => {
    return new Matrix(robot);
};
