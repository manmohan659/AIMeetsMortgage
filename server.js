require('dotenv').config();
const express = require('express');
const { Configuration, OpenAIApi } = require('openai');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');


// 1) Initialize Express
const app = express();
app.use(express.json());

// 2) Configure OpenAI
const configuration = new Configuration({
    apiKey: process.env.OPENAI_API_KEY, // Fetch the key from the .env file
});

const openai = new OpenAIApi(configuration);

// Hardcoded Loan Data
const loanData = {
    "contractName": "MortgageLoan",
    "borrower": {
        "name": "YJ",
        "contact": {
            "phone": "+1-555-123-4567",
            "email": "manny@example.com",
            "address": "123 Elm Street, Springfield, IL, 62704"
        }
    },
    "loanDetails": {
        "loanAmount": 200000,
        "loanType": "Home Loan",
        "desiredTimeline": "2025-06-30"
    }
};

// A small helper to remove markdown fences / triple backticks
function stripMarkdownFences(text) {
    // 1) Remove any lines that start with ``` (like ```solidity)
    // 2) Remove any trailing triple backticks
    // 3) Trim the result
    return text
        // Remove ```solidity or ```python or just ```
        .replace(/```(\w+)?/g, '')
        // If any leftover triple backticks remain, remove them
        .replace(/```/g, '')
        .trim();
}

// Test route
app.get('/test', (req, res) => {
    res.json({ message: 'Server is running!' });
});

// 3) Just shows generated contract code (no deployment).
app.get('/generate-prompt', async (req, res) => {
    try {
        const prompt = `
      Generate a Solidity smart contract named "${loanData.contractName}" with:
      - Borrower details: ${JSON.stringify(loanData.borrower)}
      - Loan amount: ${loanData.loanDetails.loanAmount}
      - Loan type: ${loanData.loanDetails.loanType}
      - Timeline: ${loanData.loanDetails.desiredTimeline}
      Include:
      - Borrower physicalAddress (mention address as physicalAddress) storage
      - Loan amount and type storage
      - Timeline validation
      - Loan status management (Pending, Approved, Rejected, Repaid)
      - Admin controls
      - SPDX-License-Identifier: MIT
      - pragma solidity ^0.8.0 (MUST HAVE)
    `;

        const gptResponse = await openai.createChatCompletion({
            model: 'gpt-4',
            messages: [{
                role: 'user',
                content: prompt
            }]
        });

        // The raw text from GPT
        let generatedCode = gptResponse.data.choices[0].message.content.trim();

        // For demonstration: remove markdown fences
        generatedCode = stripMarkdownFences(generatedCode);

        // Return to client
        res.json({
            prompt,
            generatedCode
        });
    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// 4) Generate & Deploy Route
app.post('/auto-deploy', async (req, res) => {
    try {
        /*******************************************************
         * (A) CALL OPENAI FOR SOLIDITY CONTRACT
         *******************************************************/
        const prompt = `
      You are a highly skilled Solidity dev.
      Generate a complete Solidity contract named "CustomMortgageLoan" for a loan with:
      - Borrower details: ${JSON.stringify(loanData.borrower)}
      - Loan amount: ${loanData.loanDetails.loanAmount}
      - Loan type: ${loanData.loanDetails.loanType}
      - Desired timeline: ${loanData.loanDetails.desiredTimeline}
      
      Requirements:
      1) pragma solidity ^0.8.0
      2) Include admin, statuses (Pending, Approved, Rejected, Repaid)
      3) Provide only valid Solidity code, NO extra text, nothing else.
      4) No lines before or after the code. Just the Solidity. 
      5) Do not use 'address' for physicalAddress. Use 'physicalAddress' in struct, etc.
    `;

        const gptResponse = await openai.createChatCompletion({
            model: 'gpt-4',
            messages: [{ role: 'user', content: prompt }],
            temperature: 0
        });

        // The raw code that might have markdown fences
        let solidityCode = gptResponse.data.choices[0].message.content.trim();

        // Clean out all markdown fences/backticks
        solidityCode = stripMarkdownFences(solidityCode);

        /*******************************************************
         * (B) WRITE THE .sol FILE
         *******************************************************/
        const timestamp = Date.now();
        const contractName = `CustomMortgageLoan_${timestamp}`;
        const contractsDir = path.join(__dirname, 'contracts');

        // Ensure contracts folder exists
        if (!fs.existsSync(contractsDir)) {
            fs.mkdirSync(contractsDir, { recursive: true });
        }

        const solFileName = `${contractName}.sol`;
        const solFilePath = path.join(contractsDir, solFileName);

        // Replace "contract CustomMortgageLoan" with the new contract name
        const updatedCode = solidityCode.replace(
            /contract\s+CustomMortgageLoan\b/g,
            `contract ${contractName}`
        );

        fs.writeFileSync(solFilePath, updatedCode, 'utf-8');
        console.log(`[SERVER] Wrote new Solidity file: ${solFileName}`);

        /*******************************************************
         * (C) CREATE A MIGRATION FILE
         *******************************************************/
        const migrationsDir = path.join(__dirname, 'migrations');
        if (!fs.existsSync(migrationsDir)) {
            fs.mkdirSync(migrationsDir, { recursive: true });
        }

        const migrationFileName = `${timestamp}_deploy_${contractName}.js`;
        const migrationFilePath = path.join(migrationsDir, migrationFileName);

        const migrationContent = `
const ${contractName} = artifacts.require("${contractName}");

module.exports = function (deployer) {
  deployer.deploy(${contractName});
};
`;
        fs.writeFileSync(migrationFilePath, migrationContent, 'utf-8');
        console.log(`[SERVER] Wrote new migration file: ${migrationFileName}`);

        /*******************************************************
         * (D) RUN TRUFFLE COMPILE & MIGRATE
         *******************************************************/
        const truffleCmd = 'truffle compile && truffle migrate --reset --network development';

        exec(truffleCmd, { cwd: __dirname }, (err, stdout, stderr) => {
            if (err) {
                console.error('[SERVER] Deployment error:', stderr);
                return res.status(500).json({ error: 'Failed to compile or deploy contract' });
            }

            console.log('[SERVER] Truffle stdout:\n', stdout);

            // (E) Attempt to parse contract address from logs
            const match = stdout.match(/contract address:\s+(0x[a-fA-F0-9]+)/);
            const contractAddress = match ? match[1] : null;

            if (!contractAddress) {
                // If not found in logs, just return a default
                return res.status(200).json({
                    contractAddress: '0x0000000000000000000000000000000000000000',
                    info: 'Contract deployed but no address found in logs.'
                });
            }

            // Return success with parsed address
            return res.json({ contractAddress });
        });

    } catch (error) {
        console.error('[SERVER] Error in auto-deploy route:', error);
        res.status(500).json({ error: error.message });
    }
});

// 5) Start Server
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
    console.log(`[SERVER] Listening on port ${PORT}`);
});