import { Service, PlatformAccessory, CharacteristicValue, HAPStatus } from 'homebridge';
import AtombergApi from './atombergApi';
import { AtombergFanPlatform } from './platform';
import { AtombergFanCommandData, AtombergFanDeviceState } from './model';

/**
 * AtombergFanPlatformAccessory with smooth HomeKit behavior
 */
export class AtombergFanPlatformAccessory {
  private fanService: Service;
  private lightbulbService: Service;

  private lastSpeedCommand: number | null = null;
  private lastPowerCommand: boolean | null = null;
  private commandTimeout: NodeJS.Timeout | null = null;
  private lastCommandTime = 0;
  private lastOnlineProbeTime = 0;
  private static readonly ONLINE_PROBE_COOLDOWN_MS = 30 * 1000;

  constructor(
    private readonly platform: AtombergFanPlatform,
    private readonly atombergApi: AtombergApi,
    private readonly accessory: PlatformAccessory,
    private fanState: AtombergFanDeviceState,
  ) {
    const device = accessory.context.device;
    let modelName = device.model || '';
    if (device.series) {
      modelName += modelName ? ` ${device.series}` : device.series;
    } else if (!modelName) modelName = 'Unknown';

    // Accessory info
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Atomberg')
      .setCharacteristic(this.platform.Characteristic.Model, modelName)
      .setCharacteristic(this.platform.Characteristic.Name, device.name || 'Unknown')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, 'Unknown');

    // Fan service
    this.fanService = this.accessory.getService(this.platform.Service.Fanv2)
      || this.accessory.addService(this.platform.Service.Fanv2);
    this.fanService.setCharacteristic(this.platform.Characteristic.Name, device.name || 'Unknown Fan');

    this.fanService.getCharacteristic(this.platform.Characteristic.Active)
      .onSet(this.setActive.bind(this));

    this.fanService.getCharacteristic(this.platform.Characteristic.RotationSpeed)
      .setProps({ minValue: 0, maxValue: 100, minStep: 1 })
      .onSet(this.setRotationSpeed.bind(this));

    // Lightbulb
    this.lightbulbService = this.accessory.getService(this.platform.Service.Lightbulb)
      || this.accessory.addService(this.platform.Service.Lightbulb);
    this.lightbulbService.setCharacteristic(
      this.platform.Characteristic.Name,
      `${device.name || 'Unknown'} LED`
    );
    this.lightbulbService.getCharacteristic(this.platform.Characteristic.On)
      .onSet(this.setLED.bind(this));
    this.lightbulbService.getCharacteristic(this.platform.Characteristic.Brightness)
      .setProps({ minValue: 0, maxValue: 100, minStep: 1 })
      .onSet(this.setLEDBrightness.bind(this));

    this.refreshDeviceStatus(this.fanState);
  }

  public markOnlineSeen(): void {
    if (!this.fanState.is_online) {
      this.fanState.is_online = true;
      this.platform.log.debug(`Device '${this.accessory.displayName}' seen on UDP heartbeat`);
    }
  }

  private async ensureOnlineOrThrow() {
    if (this.fanState.is_online) return;

    const now = Date.now();
    if (now - this.lastOnlineProbeTime < AtombergFanPlatformAccessory.ONLINE_PROBE_COOLDOWN_MS) {
      this.platform.log.info('Device is offline, cannot update characteristics');
      throw new this.platform.api.hap.HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }

    this.lastOnlineProbeTime = now;
    try {
      const deviceId = this.accessory.context.device.device_id;
      const probed = await this.atombergApi.getDeviceStateForDevice(deviceId);
      if (probed && probed.is_online) {
        this.platform.log.debug(`Device '${this.accessory.displayName}' is online (API probe)`);
        this.refreshDeviceStatus(probed);
        return;
      }
    } catch (error) {
      this.platform.log.debug('API probe failed while device marked offline');
      if (error) this.platform.log.debug(JSON.stringify(error));
    }

    this.platform.log.info('Device is offline, cannot update characteristics');
    throw new this.platform.api.hap.HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  }

  private async sendDeviceUpdate(commandData: AtombergFanCommandData) {
    await this.ensureOnlineOrThrow();
    const now = Date.now();
    const elapsed = now - this.lastCommandTime;

    // Throttle: at least 250ms between API calls
    if (elapsed < 250) {
      if (this.commandTimeout) clearTimeout(this.commandTimeout);
      this.commandTimeout = setTimeout(() => this.sendDeviceUpdate(commandData), 250 - elapsed);
      return;
    }

    this.lastCommandTime = Date.now();

    try {
      this.platform.log.debug('Sending command:', commandData);
      await this.atombergApi.sendCommand(commandData);
      this.platform.log.debug(`Command sent for '${this.accessory.displayName}'`);
    } catch (error) {
      this.platform.log.error('Error sending device update');
      if (error) this.platform.log.debug(JSON.stringify(error));
    }
  }

  // --------------------------
  // Fan Handlers
  // --------------------------

  async setActive(value: CharacteristicValue) {
    await this.ensureOnlineOrThrow();
    const powerState = value === this.platform.Characteristic.Active.ACTIVE;

    if (this.lastPowerCommand === powerState) return; // skip duplicate
    this.lastPowerCommand = powerState;
    this.fanState.power = powerState;

    this.platform.log.debug('Set Active ->', powerState);

    const cmdData: AtombergFanCommandData = powerState
      ? { device_id: this.accessory.context.device.device_id, command: { power: true, speed: this.fanState.last_recorded_speed || 1 } } as AtombergFanCommandData
      : { device_id: this.accessory.context.device.device_id, command: { power: false } } as AtombergFanCommandData;

    this.sendDeviceUpdate(cmdData);
  }

  async setRotationSpeed(value: CharacteristicValue) {
    await this.ensureOnlineOrThrow();

    // Map HomeKit 0–100% to 0–6
    let speed = Math.round((value as number) / 100 * 6);
    if (speed < 0) speed = 0;
    if (speed > 6) speed = 6;

    if (this.lastSpeedCommand === speed) return; // skip duplicate
    this.lastSpeedCommand = speed;
    this.fanState.last_recorded_speed = speed;

    this.platform.log.debug('Set Rotation Speed ->', speed);

    // Sequential: handle 0 as power OFF
    const cmdData: AtombergFanCommandData = speed === 0
      ? { device_id: this.accessory.context.device.device_id, command: { power: false } } as AtombergFanCommandData
      : { device_id: this.accessory.context.device.device_id, command: { power: true, speed } } as AtombergFanCommandData;

    // Debounce: wait 100ms to avoid sending too many rapid commands
    if (this.commandTimeout) clearTimeout(this.commandTimeout);
    this.commandTimeout = setTimeout(() => this.sendDeviceUpdate(cmdData), 100);
  }

  // --------------------------
  // LED Handlers
  // --------------------------

  async setLED(value: CharacteristicValue) {
    await this.ensureOnlineOrThrow();
    const newLED = value as boolean;
    if (this.fanState.led === newLED) return;

    this.fanState.led = newLED;
    this.platform.log.debug('Set LED ->', newLED);

    const cmdData: AtombergFanCommandData = {
      device_id: this.accessory.context.device.device_id,
      command: { led: newLED },
    } as AtombergFanCommandData;

    this.sendDeviceUpdate(cmdData);
  }

  async setLEDBrightness(value: CharacteristicValue) {
    await this.ensureOnlineOrThrow();
    const newBrightness = value as number;
    if (this.fanState.last_recorded_brightness === newBrightness) return;

    this.fanState.last_recorded_brightness = newBrightness;
    this.platform.log.debug('Set LED Brightness ->', newBrightness);

    const cmdData: AtombergFanCommandData = {
      device_id: this.accessory.context.device.device_id,
      command: { brightness: newBrightness },
    } as AtombergFanCommandData;

    this.sendDeviceUpdate(cmdData);
  }

  // --------------------------
  // Refresh Device Status
  // --------------------------

  public refreshDeviceStatus(deviceState: AtombergFanDeviceState): void {
    try {
      // Always keep in-memory state in sync so validateDeviceConnectionStatus() and UI stay correct
      this.fanState = { ...deviceState };

      if (!deviceState.is_online) {
        this.platform.log.debug(`Device '${this.accessory.displayName}' is offline`);
        // Still update UI to show off state so Home app reflects reality
        this.fanService.updateCharacteristic(this.platform.Characteristic.Active,
          this.platform.Characteristic.Active.INACTIVE);
        this.fanService.getCharacteristic(this.platform.Characteristic.RotationSpeed).updateValue(0);
        this.lightbulbService.updateCharacteristic(this.platform.Characteristic.On, false);
        this.lightbulbService.updateCharacteristic(this.platform.Characteristic.Brightness, 0);
        return;
      }

      this.platform.log.debug(`Refreshing device '${this.accessory.displayName}'`);

      // Active
      const active = deviceState.power
        ? this.platform.Characteristic.Active.ACTIVE
        : this.platform.Characteristic.Active.INACTIVE;
      this.fanService.updateCharacteristic(this.platform.Characteristic.Active, active);

      // Rotation Speed: map 0–6 to HomeKit 0–100%
      let fanSpeed = deviceState.last_recorded_speed || 0;
      if (fanSpeed < 0) fanSpeed = 0;
      if (fanSpeed > 6) fanSpeed = 6;
      const homekitSpeed = Math.round(fanSpeed / 6 * 100);
      this.fanService.getCharacteristic(this.platform.Characteristic.RotationSpeed)
        .updateValue(homekitSpeed);

      // LED
      this.lightbulbService.updateCharacteristic(
        this.platform.Characteristic.On,
        deviceState.led || false
      );
      this.lightbulbService.updateCharacteristic(
        this.platform.Characteristic.Brightness,
        deviceState.last_recorded_brightness ?? 100
      );

    } catch (error) {
      this.platform.log.error('Error refreshing device status.');
      if (error) this.platform.log.debug(JSON.stringify(error));
    }
  }
}
