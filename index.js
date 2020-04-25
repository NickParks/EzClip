'use strict';

const CURRENT_VERSION_TAG = "1.3";

const { ShortCodeExpireError, OAuthClient } = require('@mixer/shortcode-oauth');
const ws = require('ws');
const rp = require('request-promise');
const fs = require('fs');
const opn = require('opn');

const oAuthClient = new OAuthClient({
    clientId: '6a2af2fab374b9303f7d562a3a7b942d779729d831ddd852',
    scopes: ['channel:clip:create:self chat:chat chat:connect'],
});

var token;
var refreshToken;

var socket;
var currentUserId = -1;
var currentChannelName = "";
var currentChannelId = -1;

async function start() {
    const getCurrentUser = await rp('https://mixer.com/api/v1/users/current', {
        headers: {
            'Authorization': 'Bearer ' + token
        },
        json: true
    });

    currentUserId = getCurrentUser.id;
    currentChannelName = getCurrentUser.channel.token;
    currentChannelId = getCurrentUser.channel.id;

    const chatRequest = await rp(`https://mixer.com/api/v1/chats/${currentChannelId}`, {
        headers: {
            'Authorization': 'Bearer ' + token
        },
        json: true
    });

    socket = new ws(chatRequest.endpoints[0]);

    socket.on('open', () => {
        console.log("Bot is ready to go! Users in your chat can now just use !clip [length] [title]");
    });

    socket.on('close', () => {
        console.log("Chat connection closed");
    });

    socket.on('error', () => {
        console.log("Error connecting to chat");
    });

    socket.on('message', (data) => {
        let message = JSON.parse(data);

        if (message.event == "WelcomeEvent") {
            socket.send(JSON.stringify({
                "type": "method",
                "method": "auth",
                "arguments": [
                    currentChannelId,
                    currentUserId,
                    chatRequest.authkey
                ]
            }));
        }

        //This is so ugly dear god
        if (message.event == "ChatMessage") {
            let msg = buildMessage(message.data.message.message);

            if (msg[0].toLowerCase() == "!clip") {
                if (isNaN(msg[1])) {
                    createClip(60, "Clip by " + message.data.user_name, true);
                } else {
                    //If we send an empty string to Mixer for the title they auto set the title of the clip to the stream title
                    createClip(msg[1], msg.splice(2).join(' '), true);
                }
            }
        }
    });

    setInterval(() => {
        getNewTokensFromRefresh(false);
    }, 1000 * 60 * 60 * 5); //Expiry time for token
}

///////////////////////
// HELPER FUNCTIONS  //
///////////////////////
function startAttempts() {
    attempt().then(tokens => {
        token = tokens.data.accessToken;
        refreshToken = tokens.data.refreshToken;

        //Write our new tokens to file
        fs.writeFile("./authTokens.json", JSON.stringify(tokens.data), (err) => {
            if (err) {
                console.error("Failed to write new tokens to file..");
            }

            start();
        });
    });
}

//Literally ripped from the example
const attempt = () =>
    oAuthClient
        .getCode()
        .then(code => {
            console.log("Please accept the authentication window that should be open in your browser");
            opn(`https://mixer.com/go?code=${code.code}`);
            return code.waitForAccept();
        })
        .catch(err => {
            if (err instanceof ShortCodeExpireError) {
                return attempt(); // loop!
            }

            throw err;
        });

//Build a message from the weird array mixer passes down
function buildMessage(message) {
    return message[0].text.split(" ");
}

//Create the actual clip
async function createClip(length, title, shouldRetry) {
    //Mixer only allows clips up to 300 seconds long
    if (length >= 300) {
        length = 300;
    }

    let currentBroadcast;
    try {
        currentBroadcast = await rp('https://mixer.com/api/v1/broadcasts/current', {
            headers: {
                'Authorization': 'Bearer ' + token
            },
            json: true
        });
    } catch (e) {
        console.log("No broadcast found");
        return;
    }

    let broadcastID = currentBroadcast.id;
    let payload = {
        "broadcastId": broadcastID,
        "highlightTitle": title,
        "clipDurationInSeconds": length
    }

    try {
        let clipRequest = await rp.post('https://mixer.com/api/v1/clips/create', {
            headers: {
                'Authorization': 'Bearer ' + token
            },
            body: payload,
            json: true
        });

        sendChatMessage(`Clip created: https://mixer.com/${currentChannelName}?clip=${clipRequest.shareableId}`);
    } catch (e) {
        if (shouldRetry) {
            console.log("Failed to generate clip, retrying...");
            createClip(length, title, false);
        } else {
            console.log("Failed to create clip twice");
            sendChatMessage(`Failed to generate clip :(`);
        }
    }
}

//Send a chat message over the socket
function sendChatMessage(message) {
    socket.send(JSON.stringify({
        "type": "method",
        "method": "msg",
        "arguments": [message]
    }));
}

//Refresh token
function getNewTokensFromRefresh(startAfter) {
    let queryString = {
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: "6a2af2fab374b9303f7d562a3a7b942d779729d831ddd852"
    }

    rp.post('https://mixer.com/api/v1/oauth/token', {
        body: queryString,
        json: true
    }).then((result) => {
        token = result.access_token;
        refreshToken = result.refresh_token;

        let tokensToWrite = {
            accessToken: result.access_token,
            refreshToken: result.refresh_token,
            expires_in: result.expires_in
        }

        //Write our new tokens to file
        fs.writeFile("./authTokens.json", JSON.stringify(tokensToWrite), (err) => {
            if (err) {
                console.error("Failed to write new tokens to file..");
            }

            if (startAfter) {
                start();
            }
        });
    }).catch(err => {
        console.error(err);
    });
}

//Startup function
fs.exists("./authTokens.json", (exists) => {
    if (!exists) {
        //Create file then go to attempt
        fs.writeFile("./authTokens.json", JSON.stringify({}), (err) => {
            if (err) {
                console.error("Could not write data to file to save auth tokens...");
            }

            startAttempts();
        });
    } else {
        //Exists so try to read it
        fs.readFile("./authTokens.json", (error, data) => {
            if (error) {
                console.error("Error reading file, please re-auth");
                startAttempts();
                return;
            }

            let parsed = JSON.parse(data);

            if (parsed.accessToken != undefined) {
                //Set tokens
                token = parsed.accessToken;
                refreshToken = parsed.refreshToken;

                //Get new ones
                getNewTokensFromRefresh(true);

                return;
            } else {
                startAttempts();
            }
        });
    }
});

//Version checker
rp('https://api.github.com/repos/NickParks/EzClip/releases/latest', {
    headers: {
        'User-Agent': "EzClip"
    },
    json: true
}).then((value) => {
    if (value.tag_name != CURRENT_VERSION_TAG) {
        console.log('\x1b[36m%s\x1b[0m', "There is a new version available for download!");
        console.log('\x1b[36m%s\x1b[0m', value.url);
    }
}).catch(err => {
    //Error getting github
    console.error(err);
});