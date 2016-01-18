try
  {Robot,Adapter,TextMessage,User} = require 'hubot'
catch
  prequire = require('parent-require')
  {Robot,Adapter,TextMessage,User} = prequire 'hubot'

sdk = require 'matrix-js-sdk'
request = require 'request'

class Matrix extends Adapter
  constructor: ->
    super
    @robot.logger.info "Constructor"

  send: (envelope, strings...) ->
    for str in strings
      @robot.logger.info "Sending to #{envelope.room}: #{str}"
      if /^(f|ht)tps?:\/\//i.test(str)
        @sendImage envelope, str
      else
        @client.sendTextMessage envelope.room, str

  reply: (envelope, strings...) ->
    for str in strings
      @send envelope, "#{envelope.user.name}: #{str}"

  sendImage: (envelope, url) ->
    @client.uploadContent(stream: request url, name: url).done (murl) =>
        @client.sendMessage envelope.room, {
            msgtype: "m.image",
            body: url,
            url: JSON.parse(murl).content_uri
        }

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
        @robot.logger.info "Logged in #{@user_id}"
        @client = sdk.createClient
            baseUrl: process.env.HUBOT_MATRIX_HOST_SERVER || 'https://matrix.org'
            accessToken: @access_token
            userId: @user_id
        @client.on 'syncComplete', =>
            @robot.logger.info "Synced #{@client.getRooms().length} rooms"
            @emit 'connected'
        @client.on 'Room.timeline', (event, room, toStartOfTimeline) =>
            if event.getType() == 'm.room.message' and toStartOfTimeline == false
                message = event.getContent().body
                name = event.getSender()
                user = @robot.brain.userForId name
                user.room = room.roomId
                if user.name != @user_id
                    @robot.logger.info "Received message: '#{message}' in room: #{user.room}, from: #{user.name}."
                    @receive new TextMessage user, message
        @client.on 'RoomMember.membership', (event, member) =>
            if member.membership == 'invite' and member.userId == @user_id
                @client.joinRoom(member.roomId).done =>
                    @robot.logger.info "Auto-joined #{member.roomId}"
        @client.startClient 0

exports.use = (robot) ->
  new Matrix robot
