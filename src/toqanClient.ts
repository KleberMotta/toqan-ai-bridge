import axios, { AxiosInstance } from "axios";
import FormData from "form-data";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
dotenv.config();

// Debug logging helper
const logFile = path.join(process.cwd(), 'debug.log');
function debugLog(message: string, data?: any) {
  const timestamp = new Date().toISOString();
  const logEntry = `[${timestamp}] TOQAN_${message}${data ? ` | Data: ${JSON.stringify(data)}` : ''}\n`;
  fs.appendFileSync(logFile, logEntry);
}

function logToqanError(operation: string, error: any, additionalData?: any) {
  const errorData = {
    operation,
    status: error.response?.status,
    statusText: error.response?.statusText,
    data: error.response?.data,
    message: error.message,
    additionalData
  };
  debugLog('ERROR', errorData);
  console.error(`❌ Toqan API Error in ${operation}:`, errorData);
}

const BASE = (process.env.TOQAN_BASE_URL || "https://api.coco.prod.toqan.ai/api").replace(/\/+$/, "");
const KEY = process.env.TOQAN_API_KEY || "";

function headers() {
  return { "X-Api-Key": KEY, "Accept": "application/json" };
}

const client: AxiosInstance = axios.create({
  baseURL: BASE,
  headers: headers(),
  timeout: 60_000
});

export async function createConversation(user_message: string, private_user_files?: { id: string }[]) {
  try {
    const payload: any = { user_message };
    if (private_user_files) payload.private_user_files = private_user_files;
    debugLog('API_CALL', { operation: 'createConversation', payload });
    const r = await client.post("/create_conversation", payload);
    debugLog('API_SUCCESS', { operation: 'createConversation', response: r.data });
    return r.data;
  } catch (error: any) {
    logToqanError('createConversation', error, { user_message, private_user_files });
    throw error;
  }
}

export async function continueConversation(conversation_id: string, user_message: string, private_user_files?: { id: string }[]) {
  try {
    const payload: any = { conversation_id, user_message };
    if (private_user_files && private_user_files.length > 0) {
      payload.private_user_files = private_user_files;
    }
    debugLog('API_CALL', { operation: 'continueConversation', conversation_id, user_message: user_message.substring(0, 100) + '...', fileCount: private_user_files?.length || 0 });
    const r = await client.post("/continue_conversation", payload);
    debugLog('API_SUCCESS', { operation: 'continueConversation', response: r.data });
    return r.data;
  } catch (error: any) {
    logToqanError('continueConversation', error, { conversation_id, user_message, private_user_files });
    throw error;
  }
}

export async function getAnswer(conversation_id: string, request_id?: string) {
  try {
    const params: any = { conversation_id };
    if (request_id) params.request_id = request_id;
    const r = await client.get("/get_answer", { params });
    // Only log successful responses that contain actual answers, not polling responses
    if (r.data.answer && r.data.status === 'finished') {
      debugLog('API_SUCCESS', { operation: 'getAnswer', status: r.data.status, answerLength: r.data.answer?.length });
    }
    return r.data;
  } catch (error: any) {
    logToqanError('getAnswer', error, { conversation_id, request_id });
    throw error;
  }
}

export async function findConversation(body: any) {
  try {
    debugLog('API_CALL', { operation: 'findConversation', body });
    const r = await client.post("/find_conversation", body);
    debugLog('API_SUCCESS', { operation: 'findConversation', response: r.data });
    return r.data;
  } catch (error: any) {
    logToqanError('findConversation', error, { body });
    throw error;
  }
}

export async function uploadFile(bytes: Buffer, filename: string, contentType: string) {
  try {
    debugLog('API_CALL', { operation: 'uploadFile', filename, contentType, size: bytes.length });
    const form = new FormData();
    form.append("file", bytes, { filename, contentType });
    const headers = { ...form.getHeaders(), "X-Api-Key": KEY };
    const r = await axios.put(`${BASE}/upload_file`, form, { headers, timeout: 120_000 });
    debugLog('API_SUCCESS', { operation: 'uploadFile', response: r.data });
    return r.data;
  } catch (error: any) {
    logToqanError('uploadFile', error, { filename, contentType, size: bytes.length });
    throw error;
  }
}
