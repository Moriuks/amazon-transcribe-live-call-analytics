// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import fastify from 'fastify';
import websocket from '@fastify/websocket';
import WebSocket from 'ws'; // type structure for the websocket object used by fastify/websocket
import os from 'os';
import path from 'path';
import { 
    S3Client, 
    PutObjectCommand
} from '@aws-sdk/client-s3';

import fs from 'fs';
import { randomUUID } from 'crypto';
import BlockStream from 'block-stream2';

import {  
    startTranscribe, 
    CallMetaData, 
    writeCallStartEvent,
    writeCallEndEvent,
    writeCallEvent,
} from './lca';

import {
    CallRecordingEvent,
    SocketCallData,
} from './entities-lca';

import {
    createWavHeader,
    posixifyFilename,
    deleteTempFile,
    normalizeErrorForLogging,
} from './utils';

import {
    jwtVerifier,
} from './jwt-verifier';

const AWS_REGION = process.env['AWS_REGION'] || 'us-east-1';
const RECORDINGS_BUCKET_NAME = process.env['RECORDINGS_BUCKET_NAME'] || undefined;
const RECORDING_FILE_PREFIX = process.env['RECORDING_FILE_PREFIX'] || 'lca-audio-wav/';
const CPU_HEALTH_THRESHOLD = parseInt(process.env['CPU_HEALTH_THRESHOLD'] || '50', 10);
const LOCAL_TEMP_DIR = process.env['LOCAL_TEMP_DIR'] || '/tmp/';
const WS_LOG_LEVEL = process.env['WS_LOG_LEVEL'] || 'debug';
const WS_LOG_INTERVAL = parseInt(process.env['WS_LOG_INTERVAL'] || '120', 10);

const s3Client = new S3Client({ region: AWS_REGION });

const socketMap = new Map<WebSocket, SocketCallData>();

// create fastify server (with logging enabled for non-PROD environments)
const server = fastify({
    logger: {
        level: WS_LOG_LEVEL,
        prettyPrint: {
            ignore: 'pid,hostname',
            translateTime: 'SYS:HH:MM:ss.l',
            colorize: false,
            levelFirst: true,
        },
    },
    disableRequestLogging: true,
});

// register the @fastify/websocket plugin with the fastify server
server.register(websocket);

// Setup preHandler hook to authenticate 
server.addHook('preHandler', async (request, reply) => {
    if (!request.url.includes('health')) { 
        server.log.debug('Received preHandler hook for authentication. Calling jwtVerifier to authenticate.');
        server.log.debug(`Websocket Request - URI: <${request.url}>, SocketRemoteAddr: ${request.socket.remoteAddress}, Headers: ${JSON.stringify(request.headers)}`);
    
        await jwtVerifier(request, reply);
    }
});

// Setup Route for websocket connection
server.get('/api/v1/ws', { websocket: true, logLevel: 'debug' }, (connection, request) => {
    server.log.debug('Received Connection request.');
    server.log.debug(`Websocket Request - URI: <${request.url}>, SocketRemoteAddr: ${request.socket.remoteAddress}, Headers: ${JSON.stringify(request.headers)}`);

    registerHandlers(connection.socket); // setup the handler functions for websocket events
});

type HealthCheckRemoteInfo = {
    addr: string;
    tsFirst: number;
    tsLast: number;
    count: number;
};
const healthCheckStats = new Map<string, HealthCheckRemoteInfo>();

// Setup Route for health check 
server.get('/health/check', { logLevel: 'warn' }, (request, response) => {

    const now = Date.now();
    const cpuUsage = os.loadavg()[0] / os.cpus().length * 100;
    const isHealthy = cpuUsage > CPU_HEALTH_THRESHOLD ? false : true;
    const status = isHealthy ? 200 : 503;
    
    const remoteIp = request.socket.remoteAddress || 'unknown';
    const item = healthCheckStats.get(remoteIp);
    if (!item) {
        server.log.info(`First health check from new source. RemoteAddr: ${remoteIp}, URI: <${request.url}>, Headers: ${JSON.stringify(request.headers)}`);
        server.log.info(` ==> Health Check status - CPU Usage%: ${cpuUsage}, IsHealthy: ${isHealthy}, Status: ${status}`);
        healthCheckStats.set(remoteIp, { addr: remoteIp, tsFirst: now, tsLast: now, count: 1 });
    } else {
        item.tsLast = now;
        ++item.count;
        const elapsed_seconds = (item.tsLast - item.tsFirst) / 1000;
        if ((elapsed_seconds % WS_LOG_INTERVAL) == 0) {
            server.log.info(`Health check # ${item.count} from source - RemoteAddr: ${remoteIp}, URI: <${request.url}>, Headers: ${JSON.stringify(request.headers)}`);
            server.log.info(` ==> Health Check status - CPU Usage%: ${cpuUsage}, IsHealthy: ${isHealthy}, Status: ${status}`);
        }
    }

    response
        .code(status)
        .header('Cache-Control', 'max-age=0, no-cache, no-store, must-revalidate, proxy-revalidate')
        .send({ 'Http-Status': status, 'Healthy': isHealthy });
    
});

// Start the websocket server on default port 3000 if no port supplied in environment variables
server.listen(
    { 
        port: parseInt(process.env?.['SERVERPORT'] ?? '8080'),
        host: process.env?.['SERVERHOST'] ?? '127.0.0.1'
    },
    (err) => {
        if (err) {
            server.log.error(`Error starting websocket server: ${normalizeErrorForLogging(err)}`);
            process.exit(1);
        }
        server.log.debug('Websocket server is ready and listening.');
        server.log.info(`Routes: \n${server.printRoutes()}`);
    }
);

// Setup handlers for websocket events - 'message', 'close', 'error'
const registerHandlers = (ws: WebSocket): void => {
    ws.on('message', async (data, isBinary): Promise<void> => {
        try {
            if (isBinary) {
                const audioinput = Buffer.from(data as Uint8Array);
                await onBinaryMessage(ws, audioinput);
            } else {
                await onTextMessage(ws, Buffer.from(data as Uint8Array).toString('utf8'));
            }
        } catch (err) {
            server.log.error(`Error processing message: ${normalizeErrorForLogging(err)}`);
            process.exit(1);
        }
    });

    ws.on('close', (code: number) => {
        try {
            onWsClose(ws, code);
        } catch (err) {
            server.log.error(`Error in WS close handler: ${normalizeErrorForLogging(err)}`);
        }
    });

    ws.on('error', (error: Error) => {
        server.log.error(`Websocket error, forcing close: ${normalizeErrorForLogging(error)}`);
        ws.close();
    });
};

const getTempRecordingFileName = (callMetaData: CallMetaData): string => {
    return `${posixifyFilename(callMetaData.callId)}.raw`;
};

const getWavRecordingFileName = (callMetaData: CallMetaData): string => {
    return `${posixifyFilename(callMetaData.callId)}.wav`;
};

const onBinaryMessage = async (ws: WebSocket, data: Uint8Array): Promise<void> => {

    const socketData = socketMap.get(ws);

    if (socketData !== undefined && socketData.audioInputStream !== undefined &&
        socketData.writeRecordingStream !== undefined && socketData.recordingFileSize !== undefined) {
        socketData.audioInputStream.write(data);
        socketData.writeRecordingStream.write(data);
        socketData.recordingFileSize += data.length;
    } else {
        server.log.error('Error: received audio data before metadata. Check logs for errors in START event.');
    }
};

const onTextMessage = async (ws: WebSocket, data: string): Promise<void> => {
    
    const callMetaData: CallMetaData = JSON.parse(data);

    try {
        server.log.info(`Call Metadata received from client :  ${data}`);
    } catch (error) {
        server.log.error(`Error parsing call metadata: ${data} ${normalizeErrorForLogging(error)}`);
        callMetaData.callId = randomUUID();
    }
    
    if (callMetaData.callEvent === 'START') {        
        callMetaData.callId = callMetaData.callId || randomUUID();
        callMetaData.fromNumber = callMetaData.fromNumber || 'Customer Phone';
        callMetaData.toNumber = callMetaData.toNumber || 'System Phone';
        callMetaData.shouldRecordCall = callMetaData.shouldRecordCall || false;
        callMetaData.agentId = callMetaData.agentId || randomUUID();  

        server.log.debug(`Received call start event from client, writing it to KDS:  ${JSON.stringify(callMetaData)}`);

        await writeCallStartEvent(callMetaData);
        const tempRecordingFilename = getTempRecordingFileName(callMetaData);
        const writeRecordingStream = fs.createWriteStream(path.join(LOCAL_TEMP_DIR, tempRecordingFilename));
        const recordingFileSize = 0;
        const highWaterMarkSize = (callMetaData.samplingRate / 10) * 2 * 2;
        const audioInputStream = new BlockStream({ size: highWaterMarkSize });

        const socketCallMap:SocketCallData = {
            callMetadata: callMetaData,
            audioInputStream: audioInputStream,
            writeRecordingStream: writeRecordingStream,
            recordingFileSize: recordingFileSize,
            startStreamTime: new Date(),
            ended: false
        };
        socketMap.set(ws, socketCallMap);
        startTranscribe(callMetaData, audioInputStream, socketCallMap);

    } else if (callMetaData.callEvent === 'END') {
        const socketData = socketMap.get(ws);
        if (!socketData || !(socketData.callMetadata)) {
            server.log.debug(`Received END without having a call:  ${JSON.stringify(callMetaData)}`);
            return;
        }
        server.log.debug(`Received call end event from client, writing it to KDS:  ${JSON.stringify(callMetaData)}`);
        await endCall(ws, callMetaData, socketData);
    }
};

const onWsClose = async (ws:WebSocket, code: number): Promise<void> => {
    ws.close(code);
    const socketData = socketMap.get(ws);
    if (socketData) {
        server.log.debug(`Writing call end event due to websocket close event ${JSON.stringify(socketData.callMetadata)}`);
        await endCall(ws, undefined, socketData);
    }
};

const endCall = async (ws: WebSocket, callMetaData: CallMetaData|undefined, socketData: SocketCallData): Promise<void> => {
    
    if (callMetaData === undefined) {
        callMetaData = socketData.callMetadata;
    }

    if (socketData !== undefined && socketData.ended === false) {
        socketData.ended = true;

        await writeCallEndEvent(callMetaData);
        if (socketData.writeRecordingStream && socketData.recordingFileSize) {
            socketData.writeRecordingStream.end();
            const header = createWavHeader(callMetaData.samplingRate, socketData.recordingFileSize);
            const tempRecordingFilename = getTempRecordingFileName(callMetaData);
            const wavRecordingFilename = getWavRecordingFileName(callMetaData);
            const readStream = fs.createReadStream(path.join(LOCAL_TEMP_DIR, tempRecordingFilename));
            const writeStream = fs.createWriteStream(path.join(LOCAL_TEMP_DIR, wavRecordingFilename));
            writeStream.write(header);
            for await (const chunk of readStream) {
                writeStream.write(chunk);
            }
            writeStream.end();
    
            await writeToS3(tempRecordingFilename);
            await writeToS3(wavRecordingFilename);
            await deleteTempFile(path.join(LOCAL_TEMP_DIR, tempRecordingFilename));
            await deleteTempFile(path.join(LOCAL_TEMP_DIR, wavRecordingFilename));
    
            const url = new URL(RECORDING_FILE_PREFIX + wavRecordingFilename, `https://${RECORDINGS_BUCKET_NAME}.s3.${AWS_REGION}.amazonaws.com`);
            const recordingUrl = url.href;
            
            const callEvent: CallRecordingEvent = {
                EventType: 'ADD_S3_RECORDING_URL',
                CallId: callMetaData.callId,
                RecordingUrl: recordingUrl
            };
            await writeCallEvent(callEvent);
        }
        if (socketData.audioInputStream) {
            server.log.info(`Closing audio input stream:  ${JSON.stringify(callMetaData)}`);
            socketData.audioInputStream.end();
            socketData.audioInputStream.destroy();
        }
        if (socketData) {
            server.log.info(`Deleting websocket from map: ${JSON.stringify(callMetaData)}`);
            socketMap.delete(ws);
        }
    } else {
        server.log.info(`Duplicate End call event. Already received the end call event: ${JSON.stringify(callMetaData)}`);

    }
};

const writeToS3 = async (tempFileName:string) => {
    const sourceFile = path.join(LOCAL_TEMP_DIR, tempFileName);

    server.log.debug(`Uploading audio to S3: ${sourceFile}`);
    let data;
    const fileStream = fs.createReadStream(sourceFile);
    const uploadParams = {
        Bucket: RECORDINGS_BUCKET_NAME,
        Key: RECORDING_FILE_PREFIX + tempFileName,
        Body: fileStream,
    };
    try {
        data = await s3Client.send(new PutObjectCommand(uploadParams));
        server.log.debug(`Uploading to S3 complete: ${JSON.stringify(data)}`);
    } catch (err) {
        console.error(`S3 upload error: ${normalizeErrorForLogging(err)}}`);
    } finally {
        fileStream.destroy();
    }
    return data;
};