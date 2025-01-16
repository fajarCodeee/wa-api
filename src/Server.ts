import express from "express";
import { Boom } from "@hapi/boom";
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  makeInMemoryStore,
  proto,
  useMultiFileAuthState,
  WAMessageContent,
  WAMessageKey,
} from "@whiskeysockets/baileys";
import MAIN_LOGGER from "@whiskeysockets/baileys/lib/Utils/logger";
import NodeCache from "node-cache";

const logger = MAIN_LOGGER.child({});
logger.level = "info";

const msgRetryCounterCache = new NodeCache();
const store = makeInMemoryStore({ logger });
store?.readFromFile("./baileys_store_multi.json");

setInterval(() => {
  store?.writeToFile("./baileys_store_multi.json");
}, 10_000);

let sock;

async function getMessage(
  key: WAMessageKey
): Promise<WAMessageContent | undefined> {
  if (store) {
    const msg = await store.loadMessage(key.remoteJid!, key.id!);
    return msg?.message || undefined;
  }
  return proto.Message.fromObject({});
}

// const startSock = async () => {
//   const { state, saveCreds } = await useMultiFileAuthState("baileys_auth_info");
//   // fetch latest version of WA Web
//   const { version, isLatest } = await fetchLatestBaileysVersion();
//   console.log(`using WA v${version.join(".")}, isLatest: ${isLatest}`);

//   const sock = makeWASocket({
//     version,
//     logger,
//     printQRInTerminal: true,
//     auth: {
//       creds: state.creds,
//       keys: makeCacheableSignalKeyStore(state.keys, logger),
//     },
//     msgRetryCounterCache,
//     generateHighQualityLinkPreview: true,
//     getMessage,
//   });

//   store?.bind(sock.ev);

//   sock.ev.on('connection.update', (update) => {
//     const { connection, lastDisconnect } = update
//     if (connection === 'close') {
//       const shouldReconnect = (lastDisconnect.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut
//       console.log('connection closed due to ', lastDisconnect.error, ', reconnecting ', shouldReconnect)
//       // reconnect if not logged out
//       if (shouldReconnect) {
//         startSock()
//       }
//     } else if (connection === 'open') {
//       console.log('opened connection')
//     }
//   })

//   sock.ev.on("creds.update", async () => {
//     await saveCreds();
//   })

//   // history received
//   sock.ev.on("messaging-history.set", async ({ chats, contacts, messages, isLatest }) => {
//     console.log(
//       `recv ${chats.length} chats, ${contacts.length} contacts, ${messages.length} msgs (is latest: ${isLatest})`
//     );
//   })

//   // received a new message
//   sock.ev.on("messages.upsert", async (upsert) => {
//     console.log("recv messages ", JSON.stringify(upsert, undefined, 2));

//     if (upsert.type === "notify") {
//       for (const msg of upsert.messages) {
//         try {
//           const { default: ServiceLayer } = await import(
//             "./ServiceLayer.js"
//           );
//           ServiceLayer.readMessage(sock, msg);
//           delete require.cache[require.resolve("./ServiceLayer.js")];
//         } catch (e) {
//           console.log(e);
//         }
//       }
//     }
//   })

//   return sock;
// };

// Start the WhatsApp connection

let isSockReady = false;

const startSock = async () => {
  const { state, saveCreds } = await useMultiFileAuthState("baileys_auth_info");
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    logger,
    printQRInTerminal: true,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    msgRetryCounterCache,
    generateHighQualityLinkPreview: true,
    getMessage,
  });

  store?.bind(sock.ev);

  sock.ev.on("connection.update", (update) => {
    const { connection } = update;
    if (connection === "open") {
      console.log("WhatsApp connection established");
      isSockReady = true;
    } else if (connection === "close") {
      console.log("WhatsApp connection closed, retrying...");
      isSockReady = false;
      startSock(); // Reconnect
    }
  });

  sock.ev.on("creds.update", saveCreds);
};

startSock();


// Create Express server
const app = express();

// Add middleware
app.use(express.json());  // Changed from bodyParser.json()
app.use(express.urlencoded({ extended: true }));  // Added for form data support

// Add CORS middleware if needed
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  res.header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Add request logging middleware
app.use((req, res, next) => {
  console.log('Incoming request:', {
    method: req.method,
    path: req.path,
    body: req.body,
    headers: req.headers
  });
  next();
});

// API endpoint to send a message
app.post("/send-message", async (req, res) => {
  console.log('Request body:', req.body);
  
  const { number, message } = req.body;
  
  if (!number || !message) {
    return res.status(400).json({
      success: false,
      message: "field is required!",
    });
  }

  if (!sock) {
    return res.status(500).json({
      success: false,
      message: "WhatsApp connection not initialized",
    });
  }

  try {
    const jid = number.includes("@s.whatsapp.net")
      ? number
      : `${number}@s.whatsapp.net`;
      
    await sock.sendMessage(jid, { text: message });
    
    res.json({
      success: true,
      message: "Message sent successfully",
    });
  } catch (err) {
    console.error("Failed to send message:", err);
    res.status(500).json({
      success: false,
      message: "Failed to send message",
      error: err.message,
    });
  }
});

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});