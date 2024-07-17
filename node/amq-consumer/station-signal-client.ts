import { Client as StompClient } from '@stomp/stompjs';
import { WebSocket as ws } from 'ws';
import * as config from './config';
import { padZero, configBuilder } from './utils/schemaValidatorHelper';
import { ErrorTypes, IRegisterConfig } from './types';
import ISTValidator from '@walmart/ist-schemas/dist/index';

import envConfigJSON from './stationSignalBootstrap.json';

if (typeof global !== 'undefined' && typeof global.WebSocket === 'undefined') {
  //@ts-ignore
  global.WebSocket = ws;
}

export default class StationSignalClientWS {
  private static instance?: StationSignalClientWS;
  public isConnected: boolean = false;
  private stompClient!: StompClient;
  private envConfig: any;
  private istValidator?: any;
  private connectionString: string | undefined;
  private laneNumber: any;

  constructor() {
    if (StationSignalClientWS.instance) {
      return StationSignalClientWS.instance;
    }

    //@ts-ignore
    this.envConfig = envConfigJSON.boostrap_config[config.env];
    console.log('Environment : ', config.env);
    if (!this.envConfig) {
      throw new Error('Bootstrap file does not exist.');
    }
    //@ts-ignore
    this.istValidator = new ISTValidator();
    StationSignalClientWS.instance = this;
  }

  /**
   * Initialize function connects to the station queue
   * @param registerConfig register information
   * @param userName user name to connect to message broker
   * @param password password to connect to message broker
   * @returns promise with resolve or reject on initialize
   */
  initialize(registerConfig: IRegisterConfig, userName: string, password: string) {
    return new Promise((resolve, reject) => {
      const errors: string[] = [];
      if (!registerConfig.locationNumber) {
        errors.push('Location Number is not valid');
        if (!registerConfig.country) {
          errors.push('Country Code is not valid');
        }
      }
      if (errors.length) {
        reject({ errorType: ErrorTypes.ILLEGAL_ARGUMENT_EXPECTION, errorMessages: errors });
        return;
      }

      //Adding this padding for safety, in case we get 4 digits store number
      const zeroPaddedStoreNumber = padZero(registerConfig.locationNumber.toString(), 5);
      const values = [zeroPaddedStoreNumber, registerConfig.country];
      const hostName = this.envConfig.host.replace(/%s/g, () => values.shift());
      this.connectionString = configBuilder(this.envConfig.protocol, this.envConfig.port, hostName);
      this.laneNumber = registerConfig.station.laneNumber;

      console.log('Host Name ', hostName);
      console.log('Connection String ', this.connectionString);

      const connectOptions = {
        brokerURL: this.connectionString,
        connectHeaders: {
          login: userName,
          passcode: password
        },
        reconnectDelay: this.envConfig.reconnectDelay,
        heartbeatIncoming: this.envConfig.heartbeatIncoming,
        heartbeatOutgoing: this.envConfig.heartbeatOutgoing
      };

      this.stompClient = new StompClient(connectOptions);

      console.log('Amq stomp client is configured with connect options', connectOptions);

      //This Callback is invoked on every successful connection to the STOMP broker.
      this.stompClient.onConnect = (frame) => {
        this.isConnected = true;
        console.log('******Connection Established*****');
        resolve(frame.command);
      };

      //This Callback is invoked when underlying WebSocket raises an error in connecting.
      this.stompClient.onWebSocketError = (frame) => {
        this.isConnected = false;
        console.log('Error Connecting to Broker: ' + frame.message);
        reject({ errorType: ErrorTypes.CONNECTION_ERROR, errorMessages: [frame] });
      };

      //This Callback is invoked when underlying WebSocket connection is closed.
      this.stompClient.onWebSocketClose = (frame) => {
        this.isConnected = false;
        console.log('Broker is disconnected');
        reject({ errorType: ErrorTypes.CONNECTION_ERROR, errorMessages: [frame] });
      };

      this.stompClient.activate();
    });
  }

  /**
   *
   * @param event It is the event payload which will be published to the SendTopic/checkout.
   * @returns Promise with resolve if successfully published or reject if validation failed or event not published.
   */

  publish(event: any) {
    return new Promise((resolve, reject) => {
      const sendTopic =
        'SSR/' + event.eventHeader.namespace + '/' + event.eventHeader.source + '/' + event.eventHeader.eventType;
      console.log('Constructed Send Topic: ', sendTopic);
      if (this.isConnected) {
        if (this.istValidator.validate(event)) {
          console.log('Schema Verified Successfully');
          try {
            this.stompClient.publish({ destination: sendTopic, body: JSON.stringify(event) });
            console.log('Published the event');
            resolve(true);
          } catch (error: any) {
            const errorMessage: string = error && error.message ? error.message : 'Failed to Publish Event';
            // console.log('Error from publish catch', errorMessage);
            reject({ errorType: ErrorTypes.PUBLISH_EXCEPTION, errorMessages: [errorMessage] });
          }
        } else {
          const errors = this.istValidator?.getErrors();
          const validationErrors: string[] = [];
          for (let error of errors) {
            validationErrors.push(
              'Schema validation failed at => ' + error.instancePath + ', with message => ' + error.message
            );
          }
          reject({ errorType: ErrorTypes.INVALID_MESSAGE_EXCEPTION, errorMessages: [validationErrors] });
        }
      } else {
        reject({
          errorType: ErrorTypes.PUBLISH_EXCEPTION,
          errorMessages: [event.eventHeader.eventId, event.eventData]
        });
      }
    });
  }

  /**
   * Recieve any published events from checkout
   * @param callBackEvent Is invoked everytime when the client receives a message from the server
   */

  receive(callBackEvent: Function) {
    const receiveTopic = 'STATION_GATEWAY/' + this.laneNumber;
    console.log('Constructed Receive Topic: ', receiveTopic);
    if (this.isConnected) {
      try {
        console.log('******Receiving messages on topic*****');
        this.stompClient.subscribe("SSR/CHECKOUT/COSTL_SCO/TRANSACTION", function (message) {
          if (callBackEvent) {
            callBackEvent(JSON.parse(message.body), receiveTopic);
            console.log('Received event data : ' + message.body);
          }
        });
      } catch (error: any) {
        const errorMessage: string =
          error && error.message
            ? ErrorTypes.RECEIVE_EXCEPTION + ' ' + error.message
            : ErrorTypes.RECEIVE_EXCEPTION + ' Failed to receive event';
        throw new Error(errorMessage);
      }
    } else {
      throw new Error(ErrorTypes.RECEIVE_EXCEPTION + ' Error Connecting to Broker');
    }
  }
}
