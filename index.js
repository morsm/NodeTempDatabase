// -*- coding: utf-8 -*-

// Hippotronics Temperature service to add records to database

'use strict';

const http = require('http');
const url = require('url');
const https = require('https');
var Promise = require('promise');
var bodyJson = require("body/json");
const mysql = require('mysql');

var RootCA = require("ssl-root-cas/latest");
let Config = require("./config.json");


// Setup HTTP server
const server = http.createServer(handleHttpRequest);
const port = Config.lambda_port;

// Open database connection
var db = mysql.createConnection({
    host     : Config.db_host,
    user     : Config.db_user,
    password : Config.db_password,
    database : Config.db_name
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
    if (request.method == "POST") await handlePostRequest(request, response);
    else if (request.method == "GET") await handleGetRequest(request, response);
    else {
        response.statusCode = 405;
        response.statusMessage = "Only GET and POST supported";
        response.end();
    }
}

async function handleGetRequest(request, response)
{
    var params = url.parse(request.url,true).query;

    // Ensure we got everyting
    var check = ! isNaN(params.year);
    check &= ! isNaN(params.month);
    check &= ! isNaN(params.day);
    check &= ! isNaN(params.hour);
    check &= ! isNaN(params.minute);
    check &= ! isNaN(params.durationMinutes);

    if (! check)
    {
        response.statusCode = "401";
        response.statusMessage = "Parameters required: year, month, day, hour, minut, durationMinutes";
        response.end();
        return;
    }

    try {
        var responseObj = await handleDatabaseGet(params.year, params.month, params.day, params.hour, params.minute, params.durationMinutes);
        var responseBody = JSON.stringify(responseObj);

        response.statusCode = 200;
        response.setHeader("Content-Type", "application/json");
        response.setHeader("Content-Length", responseBody.length);
        response.write(responseBody);
        response.end();
    }
    catch (err)
    {
        response.statusCode = 500;
        response.statusMessage = err;
        response.end();
    }

}

async function handleDatabaseGet(year, month, day, hour, minute, duration)
{
    var startTime = new Date(year, month, day, hour, minute, 0, 0);
    var sql = "CALL GET_TEMP_FULL(?,?)";
    var param = [ startTime, duration ];

    sql = mysql.format(sql, param);

    return new Promise((resolve, reject) => {
        db.query(sql, function (error, results, fields) {
            if (error) 
            {
                reject("Error querying database with this statement: " + sql + "\n" + error);
            }
            else
            {
                resolve(transformDbGetResult(results[0]));
            }
        })
    });
    
}

function transformDbGetResult(result)
{
    var returnResult = [];

    result.forEach(element => {
        var newEl = { 
            "DateTime": element.idDateTime,
            "RoomTemperature": element.RoomTemperature,
            "RelativeHumidity": element.RelativeHumidity,
            "OutsideTemperature": element.OutsideTemperature,
            "OutsideHumidity": element.OutsideHumidity,
            "TargetTemperature": element.TargetTemperature,
            "SunIsUp": element.SunIsUp[0] == 1,
            "HeatingOn": element.HeatingOn[0] == 1,
         };

         returnResult.push(newEl);
    });

    return returnResult;
}

async function handlePostRequest(request, response)
{
    console.log("Request", request.method, request.url);

    // Validate request
    var status = 200;
    var statusMessage = "";
    var message = null;             // The JSON body of the message that was sent to us

    try
    {
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
            var responseObj = await handleDatabasePost(message);

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

async function handleDatabasePost(message) 
{
    // If local weather fails, too bad
    try {

        await getLocalWeather(message);
        
    } catch (error) {
        message.WeatherCondition = "Error: " + error;        
    }

    return insertDb(message);
}

async function insertDb(record)
{
    var sql = "CALL INSERT_TEMP(?, ?, ?, ?, ?, ?, ?, ?);"
    var param = [new Date(), record.RoomTemperature, record.RelativeHumidity, 
        record.TargetTemperature, record.OutsideTemperature, record.OutsideHumidity,
        record.HeatingOn ? 1 : 0, record.SunIsUp ? 1 : 0];
    
    sql = mysql.format(sql, param);

    return new Promise((resolve, reject) => {
        db.query(sql, function (error, results, fields) {
            if (error) 
            {
                reject("Error inserting into database with this statement: " + sql + "\n" + error);
            }
            else
            {
                resolve(record);
            }
        })
    });
}

async function getLocalWeather(message)
{
    var weather = await hippoHttpGetRequest(Config.weather_url);

    message.OutsideTemperature = weather.main.temp - 273.15;
    message.OutsideHumidity = weather.main.humidity;

    var sunrise = weather.sys.sunrise * 1000;
    var sunset = weather.sys.sunset * 1000;
    var now = Date.now();

    message.SunIsUp = (now >= sunrise) && (now < sunset);
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

        http.get(url, (res) => {
            console.log("Service responds ", res.statusCode);

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

