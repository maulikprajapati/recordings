const AWS = require("aws-sdk");
const puppeteer = require("puppeteer");
const express = require("express");
const { v4: uuidv4 } = require("uuid");
const fs = require("fs");
const path = require("path");
const { WebSocket } = require("ws");
// Configuration
const RECORDINGS_DIR = "./recordings";
const VIEWER_PORT = 3000;
const deviceId = "508_864009060908353";
// const deviceId = "409_860696065185138";
const region = "us-east-1";
const { PassThrough } = require('stream');
AWS.config.update({
  region: "us-east-1",
  accessKeyId: 'AWS_KEY',
  secretAccessKey: "AWS_SECRET",
});

const AWS_ACCESS_KEY_ID = "AWS_KEY";
const AWS_SECRET_ACCESS_KEY = "AWS_SECRET";
const S3_BUCKET_NAME = "live-view-recordings"; // Replace with your bucket name

// AWS Configuration
const s3 = new AWS.S3({
    region: "us-east-1",
    accessKeyId: "AWS_KEY",
    secretAccessKey: "AWS_SECRET",
});
// Create directories if they don't exist
if (!fs.existsSync(RECORDINGS_DIR)) {
  fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
}

// Initialize Express app
const app = express();
app.use(express.static("public"));

// AWS Configuration
AWS.config.update({
  region,
  accessKeyId: AWS_ACCESS_KEY_ID,
  secretAccessKey: AWS_SECRET_ACCESS_KEY,
});

let browser;
let page;
let viewerConnections = new Set();
let recordingInterval;

async function startPuppeteerRecorder() {
  try {
    // 1. Launch Puppeteer
    browser = await puppeteer.launch({
      headless: "new",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--use-fake-ui-for-media-stream",
      ],
    });

    page = await browser.newPage();
    page.on("console", (msg) => console.log("Browser console:", msg.text()));
    page.on("error", (error) => console.error("Browser error:", error));



    let s3UploadStream = null;
    let s3UploadPromise = null;
    let currentS3Key = null;
    const S3_PREFIX = "recordings/";
    let s3Upload = null;

    async function startS3Upload() {
        const key = `${S3_PREFIX}${Date.now()}.webm`;
        const passThrough = new PassThrough();
        
        s3Upload = {
          upload: s3.upload({
            Bucket: S3_BUCKET_NAME,
            Key: key,
            Body: passThrough,
            ContentType: 'video/webm'
          }),
          stream: passThrough
        };
        
        return key;
      }
      let started = false;
      async function writeToS3(chunk) {
        if (isFinalized) return;
        if (!started) {
            started = true;
            setTimeout(() => {
                finalizeS3Upload();
            }, 20000);
        }
        console.log('Writing to S3:', chunk.length);
        if (!s3Upload) {
            console.log('Writing to S3: INSIDE FINALIZEUPLOADS3');
          await startS3Upload();
          setTimeout(() => {
            finalizeS3Upload();
          }, 20000);
        }
        s3Upload.stream.write(Buffer.from(chunk));
      }

      let isFinalized = false;
      async function finalizeS3Upload() {
        isFinalized = true;
        console.log('Finalizing S3 upload');
        if (s3Upload) {
            console.log('Finalizing S3 upload', 1);
          s3Upload.stream.end();
          console.log('Finalizing S3 upload', 2);

          const result = await s3Upload.upload.promise();
          console.log('S3 upload complete:', result.Location);
          s3Upload = null;
          return result.Location;
        }
        return null;
      }

      await page.exposeFunction("startS3Upload", startS3Upload);
      await page.exposeFunction("writeToS3", writeToS3);
      await page.exposeFunction("finalizeS3Upload", finalizeS3Upload);

          // 2. Expose handler for saving recordings
    let recordingStream = null;
    let currentFile = null;

    async function writeRecordingChunk(chunk) {
      console.log("=========================================");
      if (!recordingStream) {
        console.log("Recording stream not initialized S3");
        await startNewRecording(chunk);
        await page.evaluate(() => window.initializeS3Upload());
      }

      recordingStream.write(Buffer.from(chunk));
      writeToS3(chunk);
    }
    async function startNewRecording(blobData) {
      console.log(
        "===================start recording======================",
        blobData
      );
      // async (blobData) => {
      if (recordingStream) {
        recordingStream.end();
      }
      console.log("===================start recording======================");

      if (!blobData) return null;
      console.log("Recording data received at server", blobData);
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");

      currentFile = path.join(RECORDINGS_DIR, `recording-${timestamp}.webm`);
      recordingStream = fs.createWriteStream(currentFile);
      console.log(`Started new recording: ${currentFile}`);
      return currentFile;
      // return filename;
      // }
    }
    async function stopRecording() {
      if (recordingStream) {
        recordingStream.end();
        console.log(`Finished recording: ${currentFile}`);
        recordingStream = null;
        const s3Url = await page.evaluate(() => window.finalizeS3Upload());
        console.log('S3 upload complete:', s3Url);
        s3UploadStream = null;
        return currentFile;
      }
      return null;
    }



    await page.exposeFunction("stopRecording", stopRecording);
    await page.exposeFunction("writeRecordingChunk", writeRecordingChunk);
    console.log("Page.go===start");
    // 3. Load viewer page
    const pg = await page.goto(`http://localhost:${VIEWER_PORT}/viewer.html`);
    // pg.text().then((text) => {
    // console.log("text", text)
    // });
    console.log("Page.go=== done");
    // 4. Set up periodic recording check
    recordingInterval = setInterval(async () => {
      try {
        const recording = await page.evaluate(async () => {
          console.log("Page.evaluate===start");
          if (
            !window.mediaRecorder ||
            window.mediaRecorder.state === "inactive"
          ) {
            return null;
          }

          return new Promise((resolve) => {
            window.mediaRecorder.requestData();
            window.mediaRecorder.ondataavailable = (event) => {
              if (event.data.size > 0) {
                resolve(event.data);
              } else {
                resolve(null);
              }
            };
          });
        });

        // if (recording) {
        //     console.log('Recording data received');
        //     const filename = await page.evaluate(async (recording) => {
        //         return await window.saveRecording(recording);
        //     }, recording);

        //     // Broadcast to viewers if needed
        //     if (filename && viewerConnections.size > 0) {
        //         const recordingData = fs.readFileSync(filename);
        //         viewerConnections.forEach(ws => {
        //             if (ws.readyState === ws.OPEN) {
        //                 ws.send(recordingData);
        //             }
        //         });
        //     }
        // }
      } catch (error) {
        console.error("Error in recording interval:", error);
      }
    }, 5000); // Check every 5 seconds

    console.log("Puppeteer recorder started successfully");
  } catch (error) {
    console.error("Error starting Puppeteer recorder:", error);
    process.exit(1);
  }
}

// Set up WebSocket server for broadcasting
const wss = new WebSocket.Server({ noServer: true });

// Start Express server
const server = app.listen(VIEWER_PORT, () => {
  console.log(`Viewer server running on port ${VIEWER_PORT}`);
  startPuppeteerRecorder();
});

// Handle WebSocket upgrades
server.on("upgrade", (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit("connection", ws, request);
  });
});

// WebSocket connection handler
wss.on("connection", (ws) => {
  viewerConnections.add(ws);
  console.log(`New viewer connected. Total viewers: ${viewerConnections.size}`);

  ws.on("close", () => {
    viewerConnections.delete(ws);
    console.log(
      `Viewer disconnected. Total viewers: ${viewerConnections.size}`
    );
  });
});

// Cleanup function
async function cleanup() {
  try {
    clearInterval(recordingInterval);
    if (page) await page.close();
    if (browser) await browser.close();
    if (server) server.close();
    console.log("Cleanup complete");
    process.exit(0);
  } catch (error) {
    console.error("Error during cleanup:", error);
    process.exit(1);
  }
}

// Handle process termination
process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);
