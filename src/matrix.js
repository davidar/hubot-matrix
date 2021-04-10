let Adapter, localStorage, Robot, TextMessage, User;
try {
  ({Robot,Adapter,TextMessage,User} = require('hubot/es2015'));
} catch (e) {
  try {
    ({Robot,Adapter,TextMessage,User} = require('hubot'));
  } catch (error) {
    let prequire = require('parent-require');
    ({Robot,Adapter,TextMessage,User} = prequire('hubot'));
  }
}

let sdk = require('matrix-js-sdk');
let request = require('request');
let sizeOf = require('image-size');

// Fetch the room whitelist if it exists
let roomWhitelist = process.env.HUBOT_MATRIX_ROOM_WHITELIST ? process.env.HUBOT_MATRIX_ROOM_WHITELIST.split(",") : null;

if (localStorage == null) {
  let {LocalStorage} = require('node-localstorage');
  localStorage = new LocalStorage('./hubot-matrix.localStorage');
}

module.exports.use = (robot) => {

let that;

class Matrix extends Adapter {
  constructor() {
    super(...arguments);
    this.robot.logger.info("Constructor");
  }

  handleUnknownDevices(err) {
    let that = this;
    return (() => {
      let result = [];
      for (var stranger in err.devices) {
        var devices = err.devices[stranger];
        result.push((() => {
          let result1 = [];
          for (let device in devices) {
            let _ = devices[device];
            that.robot.logger.info(`Acknowledging ${stranger}'s device ${device}`);
            result1.push(that.client.setDeviceKnown(stranger, device));
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
        that.robot.logger.info(`Sending to ${envelope.room}: ${str}`);
        if (/^(f|ht)tps?:\/\//i.test(str)) {
          result.push(that.sendURL(envelope, str));
        } else {
          result.push(that.client.sendNotice(envelope.room, str).catch(err => {
            if (err.name === 'UnknownDeviceError') {
              that.handleUnknownDevices(err);
              return that.client.sendNotice(envelope.room, str);
            }
          }));
        }
      }
      return result;
    })();
  }

  emote(envelope, ...strings) {
    return Array.from(strings).map((str) =>
      that.client.sendEmoteMessage(envelope.room, str).catch(err => {
        if (err.name === 'UnknownDeviceError') {
          that.handleUnknownDevices(err);
          return that.client.sendEmoteMessage(envelope.room, str);
        }
      }));
  }

  reply(envelope, ...strings) {
    return Array.from(strings).map((str) =>
      that.send(envelope, `${envelope.user.name}: ${str}`));
  }

  topic(envelope, ...strings) {
    return Array.from(strings).map((str) =>
      that.client.sendStateEvent(envelope.room, "m.room.topic", {
        topic: str
      }, ""));
  }

  sendURL(envelope, url) {
    that.robot.logger.info(`Downloading ${url}`);
    return request({url, encoding: null}, (error, response, body) => {
      if (error) {
        return that.robot.logger.info(`Request error: ${JSON.stringify(error)}`);
      } else if (response.statusCode === 200) {
        let info;
        try {
          let dims = sizeOf(body);
          that.robot.logger.info(`Image has dimensions ${JSON.stringify(dims)}, size ${body.length}`);
          if (dims.type === 'jpg') { dims.type = 'jpeg'; }
          info = { mimetype: `image/${dims.type}`, h: dims.height, w: dims.width, size: body.length };
          return that.client.uploadContent(body, {name: url, type: info.mimetype, rawResponse: false, onlyContentUri: true}).done(content_uri => {
            return that.client.sendImageMessage(envelope.room, content_uri, info, url).catch(err => {
              if (err.name === 'UnknownDeviceError') {
                that.handleUnknownDevices(err);
                return that.client.sendImageMessage(envelope.room, content_uri, info, url);
              }
            });
          });
        } catch (error1) {
          error = error1;
          that.robot.logger.info(error.message);
          return that.send(envelope, ` ${url}`);
        }
      }
    });
  }

  run() {
    that.robot.logger.info(`Run ${that.robot.name}`);
    let client = sdk.createClient(process.env.HUBOT_MATRIX_HOST_SERVER || 'https://matrix.org');
    that.robot.matrixClient = client;
    return client.login('m.login.password', {
      user: process.env.HUBOT_MATRIX_USER || that.robot.name,
      password: process.env.HUBOT_MATRIX_PASSWORD
    }, (err, data) => {
        if (err) {
            that.robot.logger.error(err);
            return;
        }
        that.user_id = data.user_id;
        that.access_token = data.access_token;
        that.device_id = data.device_id;
        that.robot.logger.info(`Logged in ${that.user_id} on device ${that.device_id}`);
        that.client = sdk.createClient({
            baseUrl: process.env.HUBOT_MATRIX_HOST_SERVER || 'https://matrix.org',
            accessToken: that.access_token,
            userId: that.user_id,
            deviceId: that.device_id,
            sessionStore: new sdk.WebStorageSessionStore(localStorage)
        });
        that.client.on('sync', (state, prevState, data) => {
            switch (state) {
              case "PREPARED":
                that.robot.logger.info(`Synced ${that.client.getRooms().length} rooms`);
                // We really don't want to let people set the display name to something other than the bot
                // name because the bot only reacts to it's own name.
                const currentDisplayName = that.client.getUser(that.user_id).displayName;
                if (that.robot.name !== currentDisplayName) {
                  that.robot.logger.info(`Setting display name to ${that.robot.name}`);
                  that.client.setDisplayName(that.robot.name, ()=>{});
                }
                return that.emit('connected');
            }
        });
        that.client.on('Room.timeline', (event, room, toStartOfTimeline) => {
            if ((event.getType() === 'm.room.message') && (toStartOfTimeline === false)) {
                that.client.setPresence("online");
                let message = event.getContent();
                let name = event.getSender();
                let prettyname = room.currentState._userIdsToDisplayNames[name];
                let user = that.robot.brain.userForId(name, { name: prettyname });
                user.room = room.roomId;
                if (user.id !== that.user_id) {
                    that.robot.logger.info(`Received message: ${JSON.stringify(message)} in room: ${user.room}, from: ${user.name}.`);

                    // Check this room against the whitelist if it exists
                    if (!roomWhitelist || roomWhitelist.includes(user.room)) {
                      if (message.msgtype === "m.text") { that.receive(new TextMessage(user, message.body)); }
                      if ((message.msgtype !== "m.text") || (message.body.indexOf(that.robot.name) !== -1)) { return that.client.sendReadReceipt(event); }
                    }
                  }
              }
        });
        that.client.on('RoomMember.membership', (event, member) => {
            if ((member.membership === 'invite') && (member.userId === that.user_id)) {
              // Don't join non whitelisted rooms
              if (!roomWhitelist || roomWhitelist.includes(member.roomId)) {
                return that.client.joinRoom(member.roomId).done(() => {
                    return that.robot.logger.info(`Auto-joined ${member.roomId}`);
                });
              }
            } else {
              that.robot.logger.info(`Ignoring invite to non whitelisted room: ${member.roomId}`);
            }
        });
        return that.client.startClient(0);
    });
  }
}
    that = new Matrix(robot);
    return that;
};
