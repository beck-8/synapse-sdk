#!/usr/bin/env node

/**
 * Dataset CLI Tool
 *
 * A command-line tool for managing datasets in the Synapse SDK.
 *
 * Usage: npx tsx utils/dataset-tools.js <command> [options]
 */

import { Synapse, calibration, mainnet } from '@filoz/synapse-sdk'
import { http, createClient } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2)
  const command = args[0]
  const options = {}

  for (let i = 1; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].substring(2)
      const value = args[i + 1]
      if (value && !value.startsWith('--')) {
        // Handle repeated --id flags by collecting them in an array
        if (key === 'id') {
          if (!options.id) {
            options.id = []
          }
          options.id.push(value)
        } else {
          options[key] = value
        }
        i++
      } else {
        options[key] = true
      }
    } else if (args[i] === '-y') {
      options.yes = true
    }
  }

  return { command, options }
}

// Parse dataset IDs from options
function parseDataSetIds(options) {
  const ids = new Set()

  // Parse --id flags (can be repeated)
  if (options.id) {
    const idList = Array.isArray(options.id) ? options.id : [options.id]
    for (const id of idList) {
      const parsed = parseInt(id, 10)
      if (Number.isNaN(parsed) || parsed < 0) {
        console.error(`Error: Invalid dataset ID "${id}". Must be a non-negative integer.`)
        process.exit(1)
      }
      ids.add(parsed)
    }
  }

  // Parse --ids flag (comma-separated)
  if (options.ids) {
    const idList = options.ids.split(',').map((s) => s.trim())
    for (const id of idList) {
      const parsed = parseInt(id, 10)
      if (Number.isNaN(parsed) || parsed < 0) {
        console.error(`Error: Invalid dataset ID "${id}" in --ids. Must be a non-negative integer.`)
        process.exit(1)
      }
      ids.add(parsed)
    }
  }

  return Array.from(ids).sort((a, b) => a - b)
}

// Format dataset info for display
function formatDataSet(dataSet) {
  const live = dataSet.isLive ? 'yes' : 'no'
  const terminated = dataSet.pdpEndEpoch > 0n ? ` (terminated at epoch ${dataSet.pdpEndEpoch})` : ''
  const managed = dataSet.isManaged ? '' : ' [External]'
  return `  #${dataSet.pdpVerifierDataSetId} - Provider: #${dataSet.providerId}, Pieces: ${dataSet.activePieceCount}, Live: ${live}${terminated}${managed}`
}

// Handle terminate command
async function handleTerminate(synapse, options) {
  const dataSetIds = parseDataSetIds(options)

  if (dataSetIds.length === 0) {
    console.error('Error: No dataset IDs provided. Use --id <id> or --ids <id,id,...>')
    process.exit(1)
  }

  console.log(`\nDatasets to terminate: ${dataSetIds.join(', ')}`)

  // Confirm unless --yes is provided
  if (!options.yes) {
    const readline = await import('readline')
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    })

    const answer = await new Promise((resolve) => {
      rl.question(`\nAre you sure you want to terminate ${dataSetIds.length} dataset(s)? [y/N] `, resolve)
    })
    rl.close()

    if (answer.toLowerCase() !== 'y' && answer.toLowerCase() !== 'yes') {
      console.log('Operation cancelled.')
      process.exit(0)
    }
  }

  console.log('')

  const results = {
    success: [],
    failed: [],
  }

  for (const dataSetIdStr of dataSetIds) {
    const dataSetId = BigInt(dataSetIdStr)
    console.log(`Terminating dataset #${dataSetId}...`)
    try {
      const txHash = await synapse.storage.terminateDataSet(dataSetId)
      console.log(`  Transaction sent: ${txHash}`)
      results.success.push(dataSetId)
    } catch (error) {
      console.error(`  Error: ${error.message}`)
      results.failed.push({ id: dataSetId, error: error.message })
    }
  }

  // Summary
  console.log('\n--- Summary ---')
  if (results.success.length > 0) {
    console.log(`Successfully terminated: ${results.success.join(', ')}`)
  }
  if (results.failed.length > 0) {
    console.log(`Failed to terminate:`)
    for (const { id, error } of results.failed) {
      console.log(`  #${id}: ${error}`)
    }
    process.exit(1)
  }
}

// Handle list command
async function handleList(synapse, options) {
  let address = options.address

  // If no address provided but we describe ourselves, use self
  if (!address && synapse.client.account) {
    address = synapse.client.account.address
  }

  if (!address) {
    console.error('Error: --address is required for list command (or --key to assume self)')
    process.exit(1)
  }

  console.log(`\nFetching datasets for address: ${address}`)

  try {
    const dataSets = (await synapse.storage.findDataSets(address)).slice() // Copy to sort

    if (dataSets.length === 0) {
      console.log('\nNo datasets found for this address.')
      return
    }

    // Sort by provider ID, then by dataset ID
    dataSets.sort((a, b) => {
      if (a.providerId !== b.providerId) {
        return Number(a.providerId - b.providerId)
      }
      return Number(a.pdpVerifierDataSetId - b.pdpVerifierDataSetId)
    })

    console.log(`\nFound ${dataSets.length} dataset(s):\n`)
    for (const dataSet of dataSets) {
      console.log(formatDataSet(dataSet))
    }
  } catch (error) {
    console.error(`\nError listing datasets: ${error.message}`)
    process.exit(1)
  }
}

// Print help
function printHelp() {
  console.log(`
Dataset CLI Tool

Usage: npx tsx utils/dataset-tools.js <command> [options]

Commands:
  terminate   Terminate one or more datasets
  list        List datasets for an address

Global Options:
  --network <network>       Network to use: 'mainnet' or 'calibration' (default: calibration)
  --rpc-url <url>           RPC endpoint (overrides network default)
  --key <private-key>       Private key for signing (required for terminate)

Terminate Options:
  --id <dataset-id>         Dataset ID to terminate (can be repeated)
  --ids <id,id,id>          Comma-separated list of dataset IDs
  --yes, -y                 Skip confirmation prompt

List Options:
  --address <address>       Address to list datasets for (defaults to signer address if --key provided)

Examples:
  # Terminate a single dataset
  npx tsx utils/dataset-tools.js terminate --key 0x... --id 123

  # Terminate multiple datasets
  npx tsx utils/dataset-tools.js terminate --key 0x... --ids 123,456,789

  # Terminate with multiple --id flags
  npx tsx utils/dataset-tools.js terminate --key 0x... --id 123 --id 456 --id 789

  # Terminate on mainnet (skip confirmation)
  npx tsx utils/dataset-tools.js terminate --key 0x... --id 123 --network mainnet -y

  # List datasets for signer address
  npx tsx utils/dataset-tools.js list --key 0x...

  # List datasets for a specific address
  npx tsx utils/dataset-tools.js list --address 0x... --network mainnet
`)
}

// Main execution
async function main() {
  const { command, options } = parseArgs()

  if (!command || command === 'help') {
    printHelp()
    process.exit(0)
  }

  // Setup chain based on network flag
  const network = options.network || 'calibration'
  if (network !== 'mainnet' && network !== 'calibration') {
    console.error(`Error: Invalid network '${network}'. Must be 'mainnet' or 'calibration'`)
    process.exit(1)
  }
  const chain = network === 'mainnet' ? mainnet : calibration
  
  // Use user provided RPC URL or let Synapse use default
  const rpcUrl = options['rpc-url']
  if (!rpcUrl && network === 'calibration') {
     console.log('Using default Calibration RPC.')
  }

  // Check key requirement
  if (command === 'terminate' && !options.key) {
      console.error('Error: --key is required for terminate command')
      process.exit(1)
  }

  // Set up account
  let account = undefined
  if (options.key) {
      try {
        const key = options.key.startsWith('0x') ? options.key : `0x${options.key}`
        account = privateKeyToAccount(key)
        console.log(`Using signer address: ${account.address}`)
      } catch (err) {
          console.error(`Error: Invalid private key. ${err.message}`)
          process.exit(1)
      }
  }

  // Manually create client and Synapse instance to avoid Synapse.create bug with undefined account
  const client = createClient({
    chain,
    transport: rpcUrl ? http(rpcUrl) : http(),
    account
  })

  const synapse = new Synapse({
      client
  })

  // Validate connection
  console.log(`Connected to Filecoin ${network} network`)

  // Execute command
  try {
    switch (command) {
      case 'terminate':
        await handleTerminate(synapse, options)
        break
      case 'list':
        await handleList(synapse, options)
        break
      default:
        console.error(`Unknown command: ${command}`)
        console.log('Run "npx tsx utils/dataset-tools.js help" for usage information')
        process.exit(1)
    }
  } catch (error) {
      console.error(`\nFailed to execute command: ${error.message}`)
      process.exit(1)
  }
}

// Run the tool
main().catch((error) => {
  console.error(`\nFatal error: ${error.message}`)
  process.exit(1)
})