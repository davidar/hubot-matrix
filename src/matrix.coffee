try
  {Robot,Adapter,TextMessage,User} = require 'hubot'
catch
  prequire = require('parent-require')
  {Robot,Adapter,TextMessage,User} = prequire 'hubot'

sdk = require 'matrix-js-sdk'
request = require 'request'
sizeOf = require 'image-size'

unless localStorage?
  {LocalStorage} = require('node-localstorage')
  localStorage = new LocalStorage('./hubot-matrix.localStorage')

class Matrix extends Adapter
  constructor: ->
    super
    @robot.logger.info "Constructor"

  handleUnknownDevices: (err) ->
    for stranger, devices of err.devices
      for device, _ of devices
        @robot.logger.info "Acknowledging #{stranger}'s device #{device}"
        @client.setDeviceKnown(stranger, device)

  send: (envelope, strings...) ->
    for str in strings
      @robot.logger.info "Sending to #{envelope.room}: #{str}"
      if /^(f|ht)tps?:\/\//i.test(str)
        @sendURL envelope, str
      else
        @client.sendNotice(envelope.room, str).catch (err) =>
          if err.name == 'UnknownDeviceError'
            @handleUnknownDevices err
            @client.sendNotice(envelope.room, str)

  emote: (envelope, strings...) ->
    for str in strings
      @client.sendEmoteMessage(envelope.room, str).catch (err) =>
        if err.name == 'UnknownDeviceError'
          @handleUnknownDevices err
          @client.sendEmoteMessage(envelope.room, str)

  reply: (envelope, strings...) ->
    for str in strings
      @send envelope, "#{envelope.user.name}: #{str}"

  topic: (envelope, strings...) ->
    for str in strings
      @client.sendStateEvent envelope.room, "m.room.topic", {
        topic: str
      }, ""

  sendURL: (envelope, url) ->
    @robot.logger.info "Downloading #{url}"
    request url: url, encoding: null, (error, response, body) =>
      if error
        @robot.logger.info "Request error: #{JSON.stringify error}"
      else if response.statusCode == 200
        try
          dims = sizeOf body
          @robot.logger.info "Image has dimensions #{JSON.stringify dims}, size #{body.length}"
          dims.type = 'jpeg' if dims.type == 'jpg'
          info = { mimetype: "image/#{dims.type}", h: dims.height, w: dims.width, size: body.length }
          @client.uploadContent(body, name: url, type: info.mimetype, rawResponse: false, onlyContentUri: true).done (content_uri) =>
            @client.sendImageMessage(envelope.room, content_uri, info, url).catch (err) =>
              if err.name == 'UnknownDeviceError'
                @handleUnknownDevices err
                @client.sendImageMessage(envelope.room, content_uri, info, url)
        catch error
          @robot.logger.info error.message
          @send envelope, " #{url}"

  run: ->
    @robot.logger.info "Run #{@robot.name}"
    client = sdk.createClient(process.env.HUBOT_MATRIX_HOST_SERVER || 'https://matrix.org')
    client.login 'm.login.password', {
      user: @robot.name
      password: process.env.HUBOT_MATRIX_PASSWORD
    }, (err, data) =>
        if err
            @robot.logger.error err
            return
        @user_id = data.user_id
        @access_token = data.access_token
        @device_id = data.device_id
        @robot.logger.info "Logged in #{@user_id} on device #{@device_id}"
        @client = sdk.createClient
            baseUrl: process.env.HUBOT_MATRIX_HOST_SERVER || 'https://matrix.org'
            accessToken: @access_token
            userId: @user_id
            deviceId: @device_id
            sessionStore: new sdk.WebStorageSessionStore(localStorage)
        @client.on 'sync', (state, prevState, data) =>
            switch state
              when "PREPARED"
                @robot.logger.info "Synced #{@client.getRooms().length} rooms"
                @emit 'connected'
        @client.on 'Room.timeline', (event, room, toStartOfTimeline) =>
            if event.getType() == 'm.room.message' and toStartOfTimeline == false
                @client.setPresence "online"
                message = event.getContent()
                name = event.getSender()
                user = @robot.brain.userForId name
                user.room = room.roomId
                if user.name != @user_id
                    @robot.logger.info "Received message: #{JSON.stringify message} in room: #{user.room}, from: #{user.name}."
                    @receive new TextMessage user, message.body if message.msgtype == "m.text"
                    @client.sendReadReceipt(event) if message.msgtype != "m.text" or message.body.indexOf(@robot.name) != -1
        @client.on 'RoomMember.membership', (event, member) =>
            if member.membership == 'invite' and member.userId == @user_id
                @client.joinRoom(member.roomId).done =>
                    @robot.logger.info "Auto-joined #{member.roomId}"
        @client.startClient 0

exports.use = (robot) ->
  new Matrix robot
