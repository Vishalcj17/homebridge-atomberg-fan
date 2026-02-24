import dgram from 'dgram';
import { Logger } from 'homebridge';
import { EventEmitter } from 'events';
import { AtombergFanDeviceState } from './model';

/**
 * BroadcastListener
 * This class is responsible for listening to broadcast messages from the Atomberg Fan devices.
 */
class BroadcastListener extends EventEmitter {
  private static instance: BroadcastListener;
  public readonly socket = dgram.createSocket('udp4');
  private readonly bindPort = 5625;
  private readonly log: Logger;

  private constructor(log: Logger) {
    super();
    this.log = log;
  }

  public static getInstance(log: Logger): BroadcastListener {
    if (!BroadcastListener.instance) {
      BroadcastListener.instance = new BroadcastListener(log);
    }
    return BroadcastListener.instance;
  }

  private onListen() {
    const address = this.socket.address();
    this.log.debug('UDP socket listening on ' + address.address + ':' + address.port);
  }

  private onMessage(message: Buffer, remote: dgram.RemoteInfo) {
    const seenDeviceId = this.parseDeviceSeen(message);
    if (seenDeviceId) {
      this.emit('deviceSeen', seenDeviceId);
    }

    const res = this.parseMessage(message) as AtombergFanDeviceState;
    this.log.debug('Received message from ' + remote.address + ':' + remote.port + ' - ' + JSON.stringify(res));
    if (res) {
      this.emit('stateChange', res);
    }
  }

  private parseDeviceSeen(message: Buffer): string | null {
    const s = message.toString('utf8').trim();
    // Some devices send a lightweight heartbeat like "a8467478c2c0_S1"
    if (s.length > 0 && s.length <= 64 && /^[a-zA-Z0-9]+_[a-zA-Z0-9]+$/.test(s)) {
      return s;
    }
    return null;
  }

  private parseMessage(message: Buffer): AtombergFanDeviceState | null {
    try {
      const utf8 = message.toString('utf8').trim();
      let jsonMessage: any;
      try {
        jsonMessage = JSON.parse(utf8);
      } catch (_) {
        // Some firmwares send a hex-encoded JSON string. Try decoding that form too.
        const maybeHex = utf8.replace(/\s+/g, '');
        if (!/^[0-9a-fA-F]+$/.test(maybeHex) || maybeHex.length % 2 !== 0) {
          throw _;
        }
        const decoded = Buffer.from(maybeHex, 'hex').toString('utf8');
        jsonMessage = JSON.parse(decoded);
      }

      const stateString = String(jsonMessage['state_string'] ?? '');
      const stateCodeRaw = Number(stateString.split(',')[0]);
      const stateCode = (stateCodeRaw >>> 0); // force unsigned 32-bit for masks/shifts

      const power = (stateCode & 0x10) !== 0;
      const led = (stateCode & 0x20) !== 0;
      const sleep = (stateCode & 0x80) !== 0;
      const speed = stateCode & 0x07;
      const fanTimer = (stateCode & 0x0F0000) >>> 16;
      const fanTimerElapsedMins = ((stateCode & 0xFF000000) >>> 24) * 4;
      // Aris Starlight Specific
      const brightness = (stateCode & 0x7F00) >>> 8;
      const cool = (stateCode & 0x08) !== 0;
      const warm = (stateCode & 0x8000) !== 0;

      return {
        'device_id': jsonMessage['device_id'],
        'is_online': true,
        'power': power,
        'led': led,
        'sleep_mode': sleep,
        'last_recorded_speed': speed,
        'timer_hours': fanTimer,
        'timer_time_elapsed_mins': fanTimerElapsedMins,
        'ts_epoch_seconds': Math.floor(Date.now() / 1000),
        'last_recorded_brightness': brightness,  // aris starlight only
        'last_recorded_color': cool ? (warm ? 'Daylight' : 'Cool') : 'Warm',  // aris starlight only
      } as AtombergFanDeviceState;
    } catch (error) {
      // Not all packets on this port are state payloads (some are heartbeats).
      // Avoid spamming logs; treat as "no state" and let deviceSeen keep it online.
      return null;
    }
  }

  public listen() {
    this.log.debug('Listening for broadcast messages on port ' + this.bindPort);
    this.socket.bind(this.bindPort);
    this.socket.on('listening', this.onListen.bind(this));
    this.socket.on('message', this.onMessage.bind(this));
  }

  public close() {
    this.socket.close();
  }
}

export default BroadcastListener;
