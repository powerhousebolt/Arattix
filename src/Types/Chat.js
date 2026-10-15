const { Message } = require('./Message');
const Participant = require('./Participant');

/**
 * Represents a single chat with its metadata, participants, and messages.
 */
class Chat {
  /**
   * @param {string} chatId - Chat identifier.
   * @param {string} title - Chat title.
   * @param {Participant} owner - Chat owner.
   * @param {Participant[]} participants - Array of participants.
   * @param {Message|Message[]|null} message - Last message(s).
   * @param {string|null} lastmsguid - Last message UID.
   */
  constructor(chatId, title, owner, participants, message, lastmsguid) {
    this.chatId = chatId;
    this.title = title;
    this.owner = owner;
    this.participants = participants;
    this.message = message;
    this.lastmsguid = lastmsguid;
  }

  toJSON() {
    return {
      chat_id: this.chatId,
      title: this.title,
      lastmsguid: this.lastmsguid,
    };
  }

  toString() {
    return JSON.stringify(this.toJSON(), null, 2);
  }

  getChatId() { return this.chatId; }
  getTitle() { return this.title; }
  getOwner() { return this.owner; }
  getParticipants() { return this.participants; }
  getLastmsguid() { return this.lastmsguid; }

  getMessage(limit) {
    if (Array.isArray(this.message)) {
      return limit ? this.message.slice(-limit) : this.message;
    }
    return this.message;
  }

  addMessage(message) {
    if (!Array.isArray(this.message)) {
      this.message = this.message ? [this.message] : [];
    }
    this.message.push(message);
  }
}

/**
 * Parses raw chat API response data into structured Chat objects.
 */
class ChatManager {
  /**
   * @param {object} chatData - Raw API response for chats.
   */
  constructor(chatData) {
    this.chats = {};
    this.chatData = chatData;
  }

  getChats() {
    return this.chats;
  }

  /**
   * Parse the raw chat data into a map of chatId -> Chat.
   * @returns {Object.<string, Chat>} Map of chat ID to Chat instances.
   */
  parseChatData() {
    const chatList = this.chatData && this.chatData.data && this.chatData.data.chats;
    if (!Array.isArray(chatList)) {
      console.error('Error parsing chat data: expected data.chats to be an array');
      return this.chats;
    }

    for (const data of chatList) {
      try {
        const chat = ChatManager.parseChat(data);
        if (chat) this.chats[chat.chatId] = chat;
      } catch (err) {
        // One malformed row must not hide every chat after it.
        console.error('Error parsing chat data:', err);
      }
    }

    return this.chats;
  }

  /**
   * Parse one raw chat entry.
   * @param {object} data - One element of `data.chats`.
   * @returns {Chat|null} null when the entry has no chat id.
   */
  static parseChat(data) {
    if (!data || !data.chatid) return null;

    const allParticipants = [];
    if (data.recipants) {
      const recipants = typeof data.recipants === 'string' ? JSON.parse(data.recipants) : data.recipants;
      for (const participant of recipants) {
        allParticipants.push(new Participant(participant.dname, participant.zuid));
      }
    }

    let lastmsguid = null;
    let msg = null;
    if (data.lastmsginfo && data.lastmsginfo !== '') {
      const lastmsginfo = typeof data.lastmsginfo === 'string' ? JSON.parse(data.lastmsginfo) : data.lastmsginfo;
      lastmsguid = lastmsginfo.msguid;
      msg = new Message(lastmsginfo.msguid, lastmsginfo.msg);
    }

    const owner = new Participant(data.owner ? data.owner.name : null, data.owner ? data.owner.id : null);
    return new Chat(data.chatid, data.title, owner, allParticipants, msg, lastmsguid);
  }
}

module.exports = { Chat, ChatManager };
