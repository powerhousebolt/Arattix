const ArattixBot = require('./Socket');
const Bot = require('./Socket/bot');
const MessageSender = require('./Socket/messages');
const { Chat, ChatManager, Message, MediaInfo, Participant } = require('./Types');
const { QRLogin, SessionManager } = require('./auth');
const Defaults = require('./Defaults');

module.exports = {
  // Core
  ArattixBot,
  Bot,
  MessageSender,

  // Types
  Chat,
  ChatManager,
  Message,
  MediaInfo,
  Participant,

  // Auth
  QRLogin,
  SessionManager,

  // Config
  Defaults,
};
