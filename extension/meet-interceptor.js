// meet-interceptor.js - Main World Interceptor for Google Meet
// Intercepts WebRTC DataChannels (collections, captions) and Protobuf RPCs
// Sourced from production-grade Attendee architecture. Runs in the page context.

(function () {
  if (window.__meetInterceptorInjected) return;
  window.__meetInterceptorInjected = true;

  console.log('[MeetInterceptor] Initialized in main world');

  // ==================== MINIMAL PROTOBUF DECODER ====================
  class MinimalReader {
    constructor(buffer) {
      this.buf = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
      this.pos = 0;
      this.len = this.buf.length;
    }
    uint32() {
      let value = 0, shift = 0, b;
      do {
        if (this.pos >= this.len) break;
        b = this.buf[this.pos++];
        value |= (b & 0x7f) << shift;
        shift += 7;
      } while (b & 0x80);
      return value >>> 0;
    }
    int64() {
      return String(this.uint32());
    }
    string() {
      const l = this.uint32();
      const bytes = this.buf.subarray(this.pos, this.pos + l);
      this.pos += l;
      return new TextDecoder('utf-8').decode(bytes);
    }
    skipType(wireType) {
      if (wireType === 0) { this.uint32(); }
      else if (wireType === 1) { this.pos += 8; }
      else if (wireType === 2) { const l = this.uint32(); this.pos += l; }
      else if (wireType === 5) { this.pos += 4; }
    }
  }

  // Schema definitions matching Google Meet internal Protobuf structure
  const messageTypes = [
    {
      name: 'CollectionEvent',
      fields: [{ name: 'body', fieldNumber: 1, type: 'message', messageType: 'CollectionEventBody' }]
    },
    {
      name: 'CollectionEventBody',
      fields: [{ name: 'userInfoListWrapperAndChatWrapperWrapper', fieldNumber: 2, type: 'message', messageType: 'UserInfoListWrapperAndChatWrapperWrapper' }]
    },
    {
      name: 'UserInfoListWrapperAndChatWrapperWrapper',
      fields: [
        { name: 'deviceInfoWrapper', fieldNumber: 3, type: 'message', messageType: 'DeviceInfoWrapper' },
        { name: 'userInfoListWrapperAndChatWrapper', fieldNumber: 13, type: 'message', messageType: 'UserInfoListWrapperAndChatWrapper' }
      ]
    },
    {
      name: 'UserInfoListWrapperAndChatWrapper',
      fields: [
        { name: 'userInfoListWrapper', fieldNumber: 1, type: 'message', messageType: 'UserInfoListWrapper' },
        { name: 'chatMessageWrapper', fieldNumber: 4, type: 'message', messageType: 'ChatMessageWrapper', repeated: true }
      ]
    },
    {
      name: 'DeviceInfoWrapper',
      fields: [{ name: 'deviceOutputInfoList', fieldNumber: 2, type: 'message', messageType: 'DeviceOutputInfoList', repeated: true }]
    },
    {
      name: 'DeviceOutputInfoList',
      fields: [
        { name: 'deviceOutputType', fieldNumber: 2, type: 'varint' },
        { name: 'streamId', fieldNumber: 4, type: 'string' },
        { name: 'deviceId', fieldNumber: 6, type: 'string' },
        { name: 'deviceOutputStatus', fieldNumber: 10, type: 'message', messageType: 'DeviceOutputStatus' }
      ]
    },
    {
      name: 'DeviceOutputStatus',
      fields: [{ name: 'disabled', fieldNumber: 1, type: 'varint' }]
    },
    {
      name: 'UserInfoListResponse',
      fields: [{ name: 'userInfoListWrapperWrapper', fieldNumber: 2, type: 'message', messageType: 'UserInfoListWrapperWrapper' }]
    },
    {
      name: 'UserInfoListWrapperWrapper',
      fields: [{ name: 'userInfoListWrapper', fieldNumber: 2, type: 'message', messageType: 'UserInfoListWrapper' }]
    },
    {
      name: 'UserEventInfo',
      fields: [{ name: 'eventNumber', fieldNumber: 1, type: 'varint' }]
    },
    {
      name: 'UserInfoListWrapper',
      fields: [
        { name: 'userEventInfo', fieldNumber: 1, type: 'message', messageType: 'UserEventInfo' },
        { name: 'userInfoList', fieldNumber: 2, type: 'message', messageType: 'UserInfoList', repeated: true }
      ]
    },
    {
      name: 'UserInfoList',
      fields: [
        { name: 'deviceId', fieldNumber: 1, type: 'string' },
        { name: 'fullName', fieldNumber: 2, type: 'string' },
        { name: 'profilePicture', fieldNumber: 3, type: 'string' },
        { name: 'status', fieldNumber: 4, type: 'varint' },
        { name: 'isCurrentUserString', fieldNumber: 7, type: 'string' },
        { name: 'displayName', fieldNumber: 29, type: 'string' },
        { name: 'parentDeviceId', fieldNumber: 21, type: 'string' },
        { name: 'isHost', fieldNumber: 34, type: 'varint' }
      ]
    },
    {
      name: 'CaptionWrapper',
      fields: [{ name: 'caption', fieldNumber: 1, type: 'message', messageType: 'Caption' }]
    },
    {
      name: 'Caption',
      fields: [
        { name: 'deviceId', fieldNumber: 1, type: 'string' },
        { name: 'captionId', fieldNumber: 2, type: 'int64' },
        { name: 'version', fieldNumber: 3, type: 'int64' },
        { name: 'isFinal', fieldNumber: 4, type: 'varint' },
        { name: 'text', fieldNumber: 6, type: 'string' },
        { name: 'languageId', fieldNumber: 8, type: 'int64' }
      ]
    }
  ];

  const messageDecoders = {};
  function createMessageDecoder(messageType) {
    return function decode(reader, length) {
      if (!(reader instanceof MinimalReader)) {
        reader = new MinimalReader(reader);
      }
      const end = length === undefined ? reader.len : reader.pos + length;
      const message = {};

      while (reader.pos < end) {
        const tag = reader.uint32();
        const fieldNumber = tag >>> 3;
        const wireType = tag & 7;

        const field = messageType.fields.find(f => f.fieldNumber === fieldNumber);
        if (!field) {
          reader.skipType(wireType);
          continue;
        }

        let value;
        switch (field.type) {
          case 'string':
            value = reader.string();
            break;
          case 'int64':
            value = reader.int64();
            break;
          case 'varint':
            value = reader.uint32();
            break;
          case 'message':
            const msgLen = reader.uint32();
            value = messageDecoders[field.messageType](reader, msgLen);
            break;
          default:
            reader.skipType(wireType);
            continue;
        }

        if (field.repeated) {
          if (!message[field.name]) message[field.name] = [];
          message[field.name].push(value);
        } else {
          message[field.name] = value;
        }
      }
      return message;
    };
  }

  messageTypes.forEach(type => {
    messageDecoders[type.name] = createMessageDecoder(type);
  });

  // State maps
  const knownUsersByDeviceId = new Map(); // deviceId -> userObj

  function base64ToUint8Array(base64) {
    const binaryString = atob(base64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes;
  }

  function emitUsersUpdate(userList) {
    if (!Array.isArray(userList) || userList.length === 0) return;
    const cleanUsers = [];

    for (const u of userList) {
      if (!u.deviceId) continue;
      // Skip screen share devices (parentDeviceId indicates a secondary screen share stream)
      if (u.parentDeviceId) continue;

      // If status is explicit 6 (not in meeting) or 7 (removed), mark not_in_meeting.
      // Otherwise, any user present in the protobuf stream is active (in_meeting).
      const isLeaving = u.status === 6 || u.status === 7;
      const userObj = {
        deviceId: u.deviceId,
        fullName: u.fullName || u.displayName || 'Unknown',
        status: isLeaving ? 'not_in_meeting' : 'in_meeting',
        isHost: !!u.isHost
      };

      knownUsersByDeviceId.set(u.deviceId, userObj);
      cleanUsers.push(userObj);
    }

    if (cleanUsers.length > 0) {
      window.postMessage({
        source: 'MEET_INTERCEPTOR',
        type: 'PARTICIPANTS_UPDATE',
        users: cleanUsers,
        allUsers: Array.from(knownUsersByDeviceId.values())
      }, '*');
    }
  }

  function decompressData(data) {
    if (!data || data.length < 2) return data;
    try {
      if (typeof pako !== 'undefined' && typeof pako.inflate === 'function') {
        return pako.inflate(data);
      }
    } catch (e) {}
    return data;
  }

  // ==================== FETCH INTERCEPTOR ====================
  const syncUrl = "google.rtc.meetings.v1.MeetingSpaceService/SyncMeetingSpaceCollections";
  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const response = await origFetch.apply(this, args);
    try {
      const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url);
      if (url && url.includes(syncUrl)) {
        const cloned = response.clone();
        cloned.text().then(text => {
          try {
            const bytes = base64ToUint8Array(text);
            const respObj = messageDecoders['UserInfoListResponse'](bytes);
            const list = respObj.userInfoListWrapperWrapper?.userInfoListWrapper?.userInfoList || [];
            emitUsersUpdate(list);
          } catch (err) {
            console.debug('[MeetInterceptor] SyncMeetingSpaceCollections parse error:', err);
          }
        });
      }
    } catch (e) {}
    return response;
  };

  // ==================== WEBRTC INTERCEPTOR ====================
  const origRTC = window.RTCPeerConnection;
  window.RTCPeerConnection = function (...args) {
    console.log('[MeetInterceptor] Intercepted RTCPeerConnection creation');
    const pc = Reflect.construct(origRTC, args);

    pc.addEventListener('datachannel', event => {
      handleDataChannel(event.channel);
    });

    const origCreateDataChannel = pc.createDataChannel.bind(pc);
    pc.createDataChannel = (label, options) => {
      const channel = origCreateDataChannel(label, options);
      handleDataChannel(channel);
      return channel;
    };

    return pc;
  };
  window.RTCPeerConnection.prototype = origRTC.prototype;

  function handleDataChannel(channel) {
    if (!channel || channel.__intercepted) return;
    channel.__intercepted = true;
    const label = channel.label || '';
    console.log('[MeetInterceptor] Intercepted DataChannel:', label);

    if (label === 'collections') {
      channel.addEventListener('message', event => {
        try {
          const raw = new Uint8Array(event.data);
          const decompressed = decompressData(raw);
          const collectionEvent = messageDecoders['CollectionEvent'](decompressed);
          const list = collectionEvent.body?.userInfoListWrapperAndChatWrapperWrapper?.userInfoListWrapperAndChatWrapper?.userInfoListWrapper?.userInfoList || [];
          emitUsersUpdate(list);
        } catch (err) {
          console.debug('[MeetInterceptor] collections event parse error:', err);
        }
      });
    }

    // FIX: Match any DataChannel whose label CONTAINS 'caption' (case-insensitive).
    // Google Meet has rotated this label across builds:
    //   'captions'  (older)  |  'CaptionsEngineDataChannel'  |  '<roomId>-captions'  (newer)
    // An exact === check broke silently when the label changed.
    if (label.toLowerCase().includes('caption')) {
      console.log('[MeetInterceptor] Captions DataChannel matched:', label);
      channel.addEventListener('message', event => {
        try {
          const raw = new Uint8Array(event.data);
          const captionWrapper = messageDecoders['CaptionWrapper'](raw);
          const cap = captionWrapper.caption;
          if (cap && cap.text) {
            const speakerObj = knownUsersByDeviceId.get(cap.deviceId);
            const speakerName = speakerObj ? speakerObj.fullName : null;

            window.postMessage({
              source: 'MEET_INTERCEPTOR',
              type: 'CAPTION_UPDATE',
              caption: {
                deviceId: cap.deviceId,
                speakerName: speakerName,
                text: cap.text,
                isFinal: cap.isFinal === 1,
                captionId: cap.captionId
              }
            }, '*');
          }
        } catch (err) {
          console.debug('[MeetInterceptor] caption event parse error:', err);
        }
      });
    }
  }

})();
