const fs = require("fs");
const axios = require("axios");
const path = require("path");

// Load environment variables from .env file
require("dotenv").config({ path: path.join(__dirname, ".env") });

// Bulk API endpoints
const CREATE_BULK_TASK_URL =
  "https://emailverifier.reoon.com/api/v1/create-bulk-verification-task/";
const GET_BULK_RESULTS_URL =
  "https://emailverifier.reoon.com/api/v1/get-result-bulk-verification-task/";
const CHECK_BALANCE_URL =
  "https://emailverifier.reoon.com/api/v1/check-account-balance/";

// Data directory and output file paths
const INPUT_DIR = path.join(__dirname, "input");
const OUTPUT_DIR = path.join(__dirname, "output");
const VALID_FILE = path.join(OUTPUT_DIR, "valid.json");
const INVALID_FILE = path.join(OUTPUT_DIR, "invalid.json");
const TASK_INFO_FILE = path.join(OUTPUT_DIR, "task-info.json");

// Configuration
const POLLING_INTERVAL_MS = 5000; // Poll every 5 seconds
const MAX_POLLING_TIME_MS = 3600000; // 1 hour max
const BATCH_SIZE = 5; // Max emails per bulk task

// Load the filtered leads data from data/input.json
const INPUT_FILE = path.join(INPUT_DIR, "input.json");

if (!fs.existsSync(INPUT_FILE)) {
  console.error(`Error: input file not found at ${INPUT_FILE}`);
  process.exit(1);
}

let leads;
try {
  leads = JSON.parse(fs.readFileSync(INPUT_FILE, "utf-8"));
} catch (error) {
  console.error(`Error parsing ${INPUT_FILE}:`, error.message);
  process.exit(1);
}

// Your API key from .env
const API_KEY = process.env.REOON_API_KEY;
if (!API_KEY) {
  console.error("Error: REOON_API_KEY not found in .env file");
  process.exit(1);
}

// Check account balance
async function checkAccountBalance() {
  try {
    const response = await axios.get(CHECK_BALANCE_URL, {
      params: { key: API_KEY },
    });
    if (response.data.status === "success") {
      console.log(`📊 Account Balance:`);
      console.log(`   Daily Credits: ${response.data.remaining_daily_credits}`);
      console.log(
        `   Instant Credits: ${response.data.remaining_instant_credits}`
      );
      return response.data;
    } else {
      console.warn("⚠️  Could not retrieve account balance");
      return null;
    }
  } catch (error) {
    console.error("Error checking account balance:", error.message);
    return null;
  }
}

// Create a bulk verification task
async function createBulkTask(emailList, taskName) {
  try {
    const payload = {
      name: taskName,
      emails: emailList,
      key: API_KEY,
    };

    const response = await axios.post(CREATE_BULK_TASK_URL, payload);

    if (response.status === 201 && response.data.status === "success") {
      console.log(`✅ Task created successfully!`);
      console.log(`   Task ID: ${response.data.task_id}`);
      console.log(`   Emails Submitted: ${response.data.count_submitted}`);
      console.log(
        `   Duplicates Removed: ${response.data.count_duplicates_removed}`
      );
      console.log(`   Rejected Emails: ${response.data.count_rejected_emails}`);
      console.log(`   Processing: ${response.data.count_processing}`);
      return response.data;
    } else {
      console.error(
        "❌ Task creation failed:",
        response.data.reason || "Unknown error"
      );
      return null;
    }
  } catch (error) {
    console.error("Error creating bulk task:", error.message);
    if (error.response?.data?.reason) {
      console.error("API Reason:", error.response.data.reason);
    }
    return null;
  }
}

// Poll for task completion
async function pollTaskResults(taskId, maxWaitTime = MAX_POLLING_TIME_MS) {
  const startTime = Date.now();
  let pollCount = 0;

  while (Date.now() - startTime < maxWaitTime) {
    try {
      pollCount++;
      const response = await axios.get(GET_BULK_RESULTS_URL, {
        params: {
          key: API_KEY,
          "task-id": taskId,
        },
      });

      const taskStatus = response.data.status;
      const progress = response.data.progress_percentage || 0;

      console.log(
        `\n📋 Poll #${pollCount}: Status = ${taskStatus}, Progress = ${progress.toFixed(
          1
        )}%`
      );

      if (taskStatus === "completed") {
        console.log(`\n✅ Task completed!`);
        console.log(
          `   Total Checked: ${response.data.count_checked}/${response.data.count_total}`
        );
        return response.data;
      } else if (taskStatus === "error" || taskStatus === "file_not_found") {
        console.error(`❌ Task error: ${response.data.reason || taskStatus}`);
        return null;
      }

      // Wait before polling again
      await new Promise((resolve) => setTimeout(resolve, POLLING_INTERVAL_MS));
    } catch (error) {
      console.error("Error polling task results:", error.message);
      return null;
    }
  }

  console.error(`❌ Task polling timeout after ${maxWaitTime / 1000} seconds`);
  return null;
}

// Ensure output directory exists
if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

// Load existing verified emails to skip already processed ones
function getAlreadyVerifiedEmails() {
  const verified = new Set();

  if (fs.existsSync(VALID_FILE)) {
    try {
      const validData = JSON.parse(fs.readFileSync(VALID_FILE, "utf-8"));
      validData.forEach((item) => {
        if (item.email) verified.add(item.email.toLowerCase());
      });
    } catch (error) {
      console.warn("Could not parse valid.json, starting fresh");
    }
  }

  if (fs.existsSync(INVALID_FILE)) {
    try {
      const invalidData = JSON.parse(fs.readFileSync(INVALID_FILE, "utf-8"));
      invalidData.forEach((item) => {
        if (item.email) verified.add(item.email.toLowerCase());
      });
    } catch (error) {
      console.warn("Could not parse invalid.json, starting fresh");
    }
  }

  return verified;
}

// Save task info for resumability
function saveTaskInfo(taskId, emailList) {
  const taskInfo = {
    taskId,
    createdAt: new Date().toISOString(),
    emailCount: emailList.length,
    emails: emailList,
  };
  fs.writeFileSync(TASK_INFO_FILE, JSON.stringify(taskInfo, null, 2), "utf-8");
}

// Load task info if resuming
function loadTaskInfo() {
  if (fs.existsSync(TASK_INFO_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(TASK_INFO_FILE, "utf-8"));
    } catch (error) {
      console.warn("Could not parse task-info.json, starting fresh");
      return null;
    }
  }
  return null;
}

// Process and save verification results
function saveResults(results, leadMap) {
  let validCount = 0;
  let invalidCount = 0;

  for (const [email, result] of Object.entries(results)) {
    const leadItem = leadMap.get(email.toLowerCase());
    if (!leadItem) continue;

    let targetFile;
    let isValid;

    // Based on bulk API response fields
    if (
      result.is_disposable ||
      result.is_spamtrap ||
      result.is_disabled ||
      !result.is_safe_to_send
    ) {
      targetFile = INVALID_FILE;
      isValid = false;
    } else {
      targetFile = VALID_FILE;
      isValid = true;
    }

    const isFirstEntry = !fs.existsSync(targetFile);
    appendToJsonFile(targetFile, leadItem, isFirstEntry);

    if (isValid) {
      validCount++;
      console.log(
        `  ✅ ${email}: ${result.status} (Score: ${
          result.overall_score || "N/A"
        })`
      );
    } else {
      invalidCount++;
      console.log(`  ❌ ${email}: ${result.status}`);
    }
  }

  return { validCount, invalidCount };
}

// Append entry to JSON file
function appendToJsonFile(filePath, entry, isFirstEntry) {
  let fileContent;

  if (isFirstEntry) {
    fileContent = JSON.stringify([entry], null, 2);
  } else {
    try {
      const existingData = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      existingData.push(entry);
      fileContent = JSON.stringify(existingData, null, 2);
    } catch (error) {
      console.error(`Error reading ${filePath}, creating new file`);
      fileContent = JSON.stringify([entry], null, 2);
    }
  }

  fs.writeFileSync(filePath, fileContent, "utf-8");
}

// Main function to process emails using bulk API
async function processEmails() {
  console.log("🚀 Starting Email Verification using Bulk API...\n");

  // Check account balance first
  await checkAccountBalance();

  const alreadyVerified = getAlreadyVerifiedEmails();
  console.log(`\n📧 Total leads: ${leads.length}`);
  console.log(`✅ Already verified: ${alreadyVerified.size}`);

  // Filter out already verified emails
  const unverifiedLeads = leads.filter(
    (lead) => !alreadyVerified.has(lead.email.toLowerCase())
  );

  if (unverifiedLeads.length === 0) {
    console.log("\n✓ All emails have been verified already!");
    if (fs.existsSync(VALID_FILE)) {
      console.log(`Valid emails saved to: ${VALID_FILE}`);
    }
    if (fs.existsSync(INVALID_FILE)) {
      console.log(`Invalid emails saved to: ${INVALID_FILE}`);
    }
    return;
  }

  console.log(`⏳ Pending verification: ${unverifiedLeads.length}\n`);

  // Create a mapping of email to lead for later use
  const leadMap = new Map();
  unverifiedLeads.forEach((lead) => {
    leadMap.set(lead.email.toLowerCase(), lead);
  });

  // Extract email addresses for bulk task
  const emailsToVerify = unverifiedLeads.map((lead) => lead.email);

  // Process in batches if needed (max 50,000 per task)
  const batches = [];
  for (let i = 0; i < emailsToVerify.length; i += BATCH_SIZE) {
    batches.push(emailsToVerify.slice(i, i + BATCH_SIZE));
  }

  console.log(`📦 Processing in ${batches.length} bulk task(s)...\n`);

  let totalValid = 0;
  let totalInvalid = 0;

  for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
    const batch = batches[batchIndex];
    const taskName = `Batch ${batchIndex + 1}/${batches.length} (${
      batch.length
    } emails)`;

    console.log(`\n${"=".repeat(60)}`);
    console.log(`📋 ${taskName}`);
    console.log(`${"=".repeat(60)}`);

    // Create bulk task
    const taskResult = await createBulkTask(batch, taskName);
    if (!taskResult) {
      console.error(`❌ Failed to create task for batch ${batchIndex + 1}`);
      continue;
    }

    // Save task info for resumability
    saveTaskInfo(taskResult.task_id, batch);

    // Poll for results
    console.log(`\n⏳ Waiting for verification results...`);
    const results = await pollTaskResults(taskResult.task_id);

    if (!results) {
      console.error(`❌ Failed to get results for batch ${batchIndex + 1}`);
      continue;
    }

    // Process and save results
    console.log(`\n📝 Processing results...`);
    const { validCount, invalidCount } = saveResults(results.results, leadMap);
    totalValid += validCount;
    totalInvalid += invalidCount;

    console.log(
      `\n   Batch Stats: ${validCount} valid, ${invalidCount} invalid`
    );
  }

  // Final summary
  console.log(`\n${"=".repeat(60)}`);
  console.log(`✓ Email verification complete!`);
  console.log(`${"=".repeat(60)}`);
  console.log(`📊 Final Results:`);
  console.log(`   ✅ Valid emails: ${totalValid}`);
  console.log(`   ❌ Invalid emails: ${totalInvalid}`);
  console.log(`   📁 Valid emails saved to: ${VALID_FILE}`);
  console.log(`   📁 Invalid emails saved to: ${INVALID_FILE}`);

  // Clean up task info file
  if (fs.existsSync(TASK_INFO_FILE)) {
    fs.unlinkSync(TASK_INFO_FILE);
  }
}

// Run the script
processEmails().catch((error) => {
  console.error("❌ Fatal error:", error.message);
  console.error(error);
  process.exit(1);
});
