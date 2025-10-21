const fs = require("fs");
const axios = require("axios");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });

// Configuration
const BATCH_SIZE = 100; // Max emails per bulk task
const POLLING_INTERVAL_MS = 5000; // Poll every 5 seconds
const MAX_POLLING_TIME_MS = 3600000; // 1 hour max

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

// Load the filtered leads data from input/data.json
const INPUT_FILE = path.join(INPUT_DIR, "data.json");

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

// Validate email format (basic check)
function isValidEmailFormat(email) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

// Clean and deduplicate emails before sending
function cleanEmailList(emailList) {
  const validEmails = [];
  const invalidEmails = [];
  const seen = new Set();

  for (const email of emailList) {
    const lowerEmail = email.toLowerCase().trim();

    if (!isValidEmailFormat(lowerEmail)) {
      invalidEmails.push(email);
    } else if (seen.has(lowerEmail)) {
      // Duplicate found
    } else {
      validEmails.push(email);
      seen.add(lowerEmail);
    }
  }

  return {
    validEmails,
    invalidCount: invalidEmails.length,
    duplicateCount:
      emailList.length - validEmails.length - invalidEmails.length,
    invalidEmails,
  };
}

// Create a bulk verification task
async function createBulkTask(emailList, taskName) {
  try {
    // Clean and validate emails before sending
    const cleanedData = cleanEmailList(emailList);
    const { validEmails, invalidCount, duplicateCount, invalidEmails } =
      cleanedData;

    // Log pre-submission stats
    if (duplicateCount > 0 || invalidCount > 0) {
      console.log(`\n📋 Pre-submission validation:`);
      if (duplicateCount > 0) {
        console.log(`   ⚠️  Duplicates found (local): ${duplicateCount}`);
      }
      if (invalidCount > 0) {
        console.log(`   ⚠️  Invalid format (local): ${invalidCount}`);
        if (invalidEmails.length <= 5) {
          invalidEmails.forEach((email) => {
            console.log(`      → ${email}`);
          });
        }
      }
    }

    const payload = {
      name: taskName,
      emails: validEmails,
      key: API_KEY,
    };

    const response = await axios.post(CREATE_BULK_TASK_URL, payload);

    if (response.status === 201 && response.data.status === "success") {
      console.log(`\n✅ Task created successfully!`);
      console.log(`   Task ID: ${response.data.task_id}`);
      console.log(`   Emails Submitted: ${response.data.count_submitted}`);
      console.log(
        `   Duplicates Removed (API): ${response.data.count_duplicates_removed}`
      );
      console.log(
        `   Rejected Emails (API): ${response.data.count_rejected_emails}`
      );
      console.log(`   Total Submitted (Local): ${validEmails.length}`);
      console.log(`   Total Duplicates (Local): ${duplicateCount}`);
      console.log(`   Total Invalid Format (Local): ${invalidCount}`);
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
function saveTaskInfo(taskId, emailList, batchIndex, totalBatches) {
  const taskInfo = {
    taskId,
    batchIndex,
    totalBatches,
    createdAt: new Date().toISOString(),
    emailCount: emailList.length,
    emails: emailList,
    status: "processing",
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

    const isValid = isEmailValid(result);
    const targetFile = isValid ? VALID_FILE : INVALID_FILE;

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

// Validate email based on all verification criteria
function isEmailValid(result) {
  const isDeliverable = result.is_deliverable !== false;
  const hasValidSyntax = result.is_valid_syntax !== false;
  const isNotDisposable = result.is_disposable !== true;
  const isNotSpamtrap = result.is_spamtrap !== true;
  const isNotDisabled = result.is_disabled !== true;
  const isSafeToSend = result.is_safe_to_send !== false;

  return (
    isDeliverable &&
    hasValidSyntax &&
    isNotDisposable &&
    isNotSpamtrap &&
    isNotDisabled &&
    isSafeToSend
  );
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

  // Check for existing task info (resume from crash)
  const existingTaskInfo = loadTaskInfo();
  let resumeFromBatch = 0;
  let resumeTaskId = null;

  if (existingTaskInfo) {
    console.log("⏸️  Found incomplete task - Attempting to resume...\n");
    console.log(`📋 Task Info:`);
    console.log(`   Task ID: ${existingTaskInfo.taskId}`);
    console.log(
      `   Batch: ${existingTaskInfo.batchIndex} / ${existingTaskInfo.totalBatches}`
    );
    console.log(`   Created: ${existingTaskInfo.createdAt}`);
    console.log(`   Emails: ${existingTaskInfo.emailCount}\n`);

    resumeFromBatch = existingTaskInfo.batchIndex;
    resumeTaskId = existingTaskInfo.taskId;

    // Try to get results from the pending task
    console.log("🔍 Checking if previous task is completed...\n");
    const previousResults = await pollTaskResults(resumeTaskId, 30000); // 30 sec timeout for check

    if (previousResults && previousResults.status === "completed") {
      console.log("\n✅ Previous task completed! Retrieving results...\n");

      // Create lead map for existing task
      const leadMap = new Map();
      existingTaskInfo.emails.forEach((email) => {
        const lead = leads.find(
          (l) => l.email.toLowerCase() === email.toLowerCase()
        );
        if (lead) {
          leadMap.set(email.toLowerCase(), lead);
        }
      });

      // Process and save the completed task results
      const { validCount, invalidCount } = saveResults(
        previousResults.results,
        leadMap
      );

      console.log(
        `\n   Recovered Results: ${validCount} valid, ${invalidCount} invalid`
      );

      // Clean up and continue to next batch
      if (fs.existsSync(TASK_INFO_FILE)) {
        fs.unlinkSync(TASK_INFO_FILE);
      }

      resumeFromBatch += 1; // Move to next batch
      resumeTaskId = null;
    } else if (previousResults) {
      console.log(
        `⏳ Previous task still processing (Status: ${previousResults.status})`
      );
      console.log(
        "Please wait for it to complete or manually delete task-info.json to start fresh.\n"
      );
      return;
    } else {
      console.log("⚠️  Could not reach previous task. Starting fresh...\n");
      if (fs.existsSync(TASK_INFO_FILE)) {
        fs.unlinkSync(TASK_INFO_FILE);
      }
    }
  }

  // Check account balance
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
  if (resumeFromBatch > 0) {
    console.log(
      `📌 Resuming from Batch ${resumeFromBatch + 1}/${batches.length}\n`
    );
  }

  let totalValid = 0;
  let totalInvalid = 0;
  let totalDuplicates = 0;
  let totalRejected = 0;

  for (
    let batchIndex = resumeFromBatch;
    batchIndex < batches.length;
    batchIndex++
  ) {
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

    // Track API-reported stats
    totalDuplicates += taskResult.count_duplicates_removed || 0;
    totalRejected += taskResult.count_rejected_emails || 0;

    // Save task info for resumability
    saveTaskInfo(taskResult.task_id, batch, batchIndex, batches.length);

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
  console.log(`\n   Verification Results:`);
  console.log(`   ✅ Valid emails: ${totalValid}`);
  console.log(`   ❌ Invalid emails: ${totalInvalid}`);
  console.log(`\n   Data Quality:`);
  console.log(`   📌 Duplicates removed (API): ${totalDuplicates}`);
  console.log(`   📌 Rejected emails (API): ${totalRejected}`);
  console.log(`\n   Output Files:`);
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
