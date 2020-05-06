// -*- coding: utf-8 -*-

// Hippotronics Temperature service to add records to database

'use strict';

const http = require('http');
const https = require('https');
var Promise = require('promise');
var bodyJson = require("body/json");

var RootCA = require("ssl-root-cas/latest");
var AWS = require("aws-sdk");

let Config = require("./config.json");


// Setup HTTP server
const server = http.createServer(handleHttpRequest);
const port = Config.lambda_port;

// Setup database connection
var wowsersItsAMadAgent = new https.Agent();
wowsersItsAMadAgent.options.ca = RootCA.create();
AWS.NodeHttpClient.sslAgent = wowsersItsAMadAgent;

AWS.config.update({
    region: "eu-west-1",
    endpoint: "https://dynamodb.eu-west-1.amazonaws.com",
    credentials: { accessKeyId: Config.access_key, secretAccessKey: Config.secret_key }
  });
  

server.listen(port, (err) => {
    if (err) 
    {
        return console.log("Error creating server", err);
    }

    console.log("NodeTempDatabase lambda running on port", port);
});


async function handleHttpRequest(request, response)
{
    console.log("Request", request.method, request.url);

    // Validate request
    var status = 200;
    var statusMessage = "";
    var message = null;             // The JSON body of the message that was sent to us

    try
    {
        if (request.method != "POST") { statusMessage = "Only POST supported"; throw 405; }
        if (! request.headers["content-type"] ) { statusMessage = "No Content-Type"; throw 400; }
        if (! request.headers["content-type"].startsWith("application/json")) { statusMessage = "Has to be application/json"; throw 400; }

        // Decode body
        statusMessage = "Bad JSON body";
        message = await new Promise((resolve, reject) => {
            bodyJson(request, function (err, body) {
                if (err) reject(400); // Bad request
                else resolve(body);
            });
        });

        // All is well
        statusMessage = "OK";
    } 
    catch (stat)
    {
        status = stat;
    }

    if (200 == status && null != message)
    {
        // Synchronously process message
        try
        {
            var responseObj = await handleRequest(message);

            var responseBody = JSON.stringify(responseObj);
            console.log("Returning to caller", responseBody);
            
            response.setHeader("Content-Type", "application/json");
            response.setHeader("Content-Length", responseBody.length);
            response.write(responseBody);
        }
        catch (err)
        {
            console.log("Error processing request", err);

            status = 500;
            statusMessage = "Internal server error";
        }
    }

    response.statusCode = status;
    response.status = statusMessage;
    response.end();
}

async function handleRequest(message) 
{
    var time = new Date();
    message.ID = time.toISOString();
    message.Year = time.getFullYear();
    message.Month = time.getMonth();
    message.Day = time.getDate();
    message.Hour = time.getHours();
    message.Minute = time.getMinutes();
    message.Second = time.getSeconds();

    // TODO: add more parameters to message

    var docClient = new AWS.DynamoDB.DocumentClient();
    var params = {
        TableName: "Temperature",
        Item: message
    };

    return new Promise((resolve, reject) => {
        docClient.put(params, function(err, data) {
            if (err) {
                reject(err);
            } else {
                console.log("Added item:", JSON.stringify(data, null, 2));
                resolve(data);
            }
        });
    });
}




async function hippoHttpGetRequest(url)
{
    console.log("Executing HTTP get to", url);

    return new Promise((resolve, reject) => {
        var options = {
            host: Config.remote_host,
            port: Config.remote_port,
            path: url
        };

        http.get(options, (res) => {
            console.log("Hippotronics responds ", res.statusCode);

            if (200 == res.statusCode) 
            {
                bodyJson(res, function (err, body) {
                   if (err) reject(err);
                   else resolve(body);
                });
            }
            else reject(res.statusCode);
        });

    });
}

async function hippoHttpPostRequest(url, body)
{
    console.log("Sending POST to HippoTronics ----");
    var bodyTxt = JSON.stringify(body);
    console.log(bodyTxt);
    
    return new Promise( (resolve, reject) =>
    {
        var options = {
            host: Config.remote_host,
            port: Config.remote_port,
            path: url,
            method: 'POST',
            headers: {
                "Content-Type": "application/json",
                "Content-Length": bodyTxt.length
            }
        };
    
        var req = http.request(options, (res) => {
            console.log("Hippotronics responds ", res.statusCode);

            if (200 == res.statusCode) resolve(res.statusCode); else 
            {
                var errorMessage = "Http Error: " + res.statusCode + " " + res.statusMessage;
                console.log(errorMessage);
                reject(errorMessage);
            }
        });
        
        req.on('error', (error) => {
            console.log("On Error HTTP Request: " + error);
            reject(error)
        });
        
        req.write(bodyTxt);
        req.end();
    });
}

