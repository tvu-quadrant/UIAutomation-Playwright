require('dotenv').config();
const url = process.env.PLAYWRIGHT_SERVICE_URL;

if (!url) {
    console.log("URL is missing");
    process.exit(1);
}

console.log("Contains accessToken:", url.includes("accessToken="));
