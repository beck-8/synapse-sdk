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
    } else if (args[i] === '--all') {
      options.all = true
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
  let targetDataSets = []

  // Check for --all flag
  if (options.all) {
    if (!synapse.client.account) {
      console.error('Error: signer address required for --all. Please provide --key.')
      process.exit(1)
    }
    const address = synapse.client.account.address
    console.log(`Fetching all datasets for ${address}...`)
    try {
      const currentBlock = await synapse.client.getBlockNumber()
      const allDataSets = await synapse.storage.findDataSets(address)
      
      console.log(`Current Block: ${currentBlock}`)
      console.log(`Total Datasets Found: ${allDataSets.length}`)

      // Filter out expired datasets
      targetDataSets = allDataSets.filter(ds => {
          if (ds.pdpEndEpoch === 0n) return true 
          return ds.pdpEndEpoch > currentBlock
      })
      
      const activeCount = targetDataSets.filter(ds => ds.pdpEndEpoch === 0n).length
      const futureTerminatedCount = targetDataSets.length - activeCount
      
      const expiredCount = allDataSets.length - targetDataSets.length
      console.log(`Filtering results:`)
      console.log(`- Expired (already terminated & past): ${expiredCount}`)
      console.log(`- Active (no end epoch): ${activeCount}`)
      console.log(`- Terminated but valid (end epoch > current): ${futureTerminatedCount}`)
      console.log(`- TOTAL to process: ${targetDataSets.length}`)

      if (targetDataSets.length > 0) {
          console.log(`Sample filtered datasets (first 5):`)
          targetDataSets.slice(0, 5).forEach(ds => {
              console.log(`  ID #${ds.pdpVerifierDataSetId}, EndEpoch: ${ds.pdpEndEpoch}, Provider: ${ds.providerId}`)
          })
      }
      
    } catch (error) {
       console.error(`Error fetching datasets: ${error.message}`)
       process.exit(1)
    }
  } else {
    // Parse IDs
    const dataSetIds = parseDataSetIds(options)
    if (dataSetIds.length === 0) {
      console.error('Error: No dataset IDs provided. Use --id <id>, --ids <id,id,...> or --all')
      process.exit(1)
    }

    // We need providerId to create context. Converting IDs to dataset info.
    // For provided IDs, we need to fetch info to get the provider ID.
    // The most efficient way usually is to findDataSets and filter, 
    // unless there is a direct getDataSet method exposed easily.
    // synapse.storage.findDataSets gets everything for the client.
    
    if (!synapse.client.account) {
        console.error('Error: signer required to fetch dataset details.')
        process.exit(1)
    }
    const address = synapse.client.account.address
    console.log(`Fetching dataset details for ${address}...`)
    try {
        const allDataSets = await synapse.storage.findDataSets(address)
        const idSet = new Set(dataSetIds.map(id => BigInt(id)))
        targetDataSets = allDataSets.filter(ds => idSet.has(ds.pdpVerifierDataSetId))
        
        // check if any were missed
        const foundIds = new Set(targetDataSets.map(ds => ds.pdpVerifierDataSetId))
        const missed = dataSetIds.filter(id => !foundIds.has(BigInt(id)))
        if (missed.length > 0) {
            console.warn(`Warning: Could not find details for dataset IDs: ${missed.join(', ')} (skipping)`)
        }
    } catch (error) {
        console.error(`Error fetching dataset details: ${error.message}`)
        process.exit(1)
    }
  }

  if (targetDataSets.length === 0) {
    console.log('No matching datasets found.')
    process.exit(0)
  }

  console.log(`\nDatasets to process: ${targetDataSets.length}`)
  targetDataSets.forEach(ds => console.log(formatDataSet(ds)))


  // Confirm unless --yes is provided
  if (!options.yes) {
    const readline = await import('readline')
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    })

    const answer = await new Promise((resolve) => {
      rl.question(`\nAre you sure you want to delete pieces and terminate ${targetDataSets.length} dataset(s)? [y/N] `, resolve)
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

  for (const ds of targetDataSets) {
    const dataSetId = ds.pdpVerifierDataSetId
    console.log(`Processing dataset #${dataSetId} (Provider: ${ds.providerId})...`)
    
    try {
        // 1. Create Storage Context
        // We use the specific provider ID from the dataset details
        const context = await synapse.storage.createContext({
            dataSetId: dataSetId,
            providerId: ds.providerId,
            withCDN: ds.withCDN
        })

        // 2. Delete Pieces
        console.log(`  Fetching pieces...`)
        // getPieces returns an async generator
        let piecesDeleted = 0
        const CONCURRENCY_LIMIT = 20
        let activeDeletions = []
        
        try {
            for await (const piece of context.getPieces()) {
                const deletePromise = (async () => {
                    console.log(`  Deleting piece ${piece.pieceCid}...`)
                    try {
                        await context.deletePiece(piece.pieceCid)
                        piecesDeleted++
                    } catch (err) {
                        console.warn(`  Warning during piece deletion: ${err.message}`)
                    }
                })()

                activeDeletions.push(deletePromise)

                if (activeDeletions.length >= CONCURRENCY_LIMIT) {
                    await Promise.race(activeDeletions)
                    // Remove completed promises (simplistic approach, or just wait for one slot)
                    // Better approach: filter out completed ones.
                    // Actually, for simplicity with robust error handling:
                    await Promise.all(activeDeletions)
                    activeDeletions = []
                }
            }
            // Wait for remaining
            await Promise.all(activeDeletions)
            
        } catch (err) {
            console.warn(`  Warning during piece listing/deletion: ${err.message}`)
        }
        
        if (piecesDeleted > 0) {
            console.log(`  Deleted ${piecesDeleted} pieces.`)
        } else {
            console.log(`  No active pieces found.`)
        }

        // 3. Terminate Dataset
        // Only terminate if it's not already terminated?
        // The user said "if it hasn't expired, execute it". 
        // pdpEndEpoch > 0 means it is terminated (or at least has an end epoch set).
        // Usually 0 means active/indefinite.
        if (ds.pdpEndEpoch === 0n) {
             console.log(`  Terminating dataset...`)
             const txHash = await synapse.storage.terminateDataSet(dataSetId)
             console.log(`  Termination transaction: ${txHash}`)
        } else {
            console.log(`  Dataset already terminated (End Epoch: ${ds.pdpEndEpoch}). Skipping termination.`)
        }

        results.success.push(dataSetId)

    } catch (error) {
      console.error(`  Error processing dataset #${dataSetId}: ${error.message}`)
      results.failed.push({ id: dataSetId, error: error.message })
    }
  }

  // Summary
  console.log('\n--- Summary ---')
  if (results.success.length > 0) {
    console.log(`Successfully processed: ${results.success.join(', ')}`)
  }
  if (results.failed.length > 0) {
    console.log(`Failed to process:`)
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
  --all                     Terminate ALL datasets for the signer
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

  # Terminate ALL datasets (delete pieces + terminate)
  npx tsx utils/dataset-tools.js terminate --key 0x... --all

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
    transport: rpcUrl ? http(rpcUrl, { timeout: 60_000 }) : http(undefined, { timeout: 60_000 }),
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