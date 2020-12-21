import * as core from '@actions/core'
import run from './main'

run().catch((error: Error) => {
  core.setFailed(error.message)
})
