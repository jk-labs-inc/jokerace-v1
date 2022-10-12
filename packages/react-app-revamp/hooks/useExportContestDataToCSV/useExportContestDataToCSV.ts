import { chains } from "@config/wagmi";
import shallow from "zustand/shallow";
import { useStore as useStoreContest } from "@hooks/useContest/store";
import { chain, fetchEnsName, readContract, fetchEnsResolver } from "@wagmi/core";
import { useRouter } from "next/router";
import { HEADERS_KEYS } from "@config/react-csv/export-contest";
import { createExportDataStore } from "./store";
import getContestContractVersion from "@helpers/getContestContractVersion";
import { useEffect } from "react";
import {
  useQuery,
} from "@tanstack/react-query"
import { makeStorageClient } from "@config/web3storage";
import { objectToCsv } from '@helpers/objectToCsv'

const useStoreExportData = createExportDataStore();

export function useExportContestDataToCSV() {
  const stateExportData = useStoreExportData();
  const { asPath } = useRouter();
  const queryContestResults = useQuery(
    ['contest-result', asPath.split("/")[3]],
    retrieveContestResultsCid
  )

  //@ts-ignore
  const { listProposalsData, listProposalsIds } = useStoreContest(
    state => ({
      //@ts-ignore
      listProposalsData: state.listProposalsData,
      //@ts-ignore
      listProposalsIds: state.listProposalsIds,
    }),
    shallow,
  );

  async function retrieveContestResultsCid() {
    if (process.env.NEXT_PUBLIC_SUPABASE_URL !== '' && process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY !== '' && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
      const config = await import('@config/supabase')
      const supabase = config.supabase

      try {
        const url = asPath.split("/");
        const contestAddress = url[3];
        const chainName = url[2];    
        const result = await supabase
        .from("results")
        .select("cid")
        .eq("contest_address", contestAddress)
        .eq("contest_network_name", chainName)

        const { data, error } = result
        if(error) {
          throw new Error(error.message)
        }
        
        if (data?.length > 0) {
          stateExportData.setCid(data[0]?.cid)
        }

        return data
      } catch(e) {
        console.error(e)
      }
    }
  }

  /**
   * Fetch the list of voters for a given proposal
   * @param proposalId - id of the proposal
   * @returns Array of voters addresses
   */
  async function fetchProposalVoters(proposalId: number | string) {
    const url = asPath.split("/");
    const chainId = chains.filter(chain => chain.name.toLowerCase().replace(" ", "") === url[2])?.[0]?.id;
    const address = url[3];
    const chainName = url[2];
    const abi = await getContestContractVersion(address, chainName);
    if (abi === null) {
      return;
    }
    try {
      const contractConfig = {
        addressOrName: address,
        contractInterface: abi,
        chainId: chainId,
      };
      //@ts-ignore
      const list = await readContract({
        ...contractConfig,
        functionName: "proposalAddressesHaveVoted",
        chainId,
        args: proposalId,
      });
      return list;
    } catch (e) {
      console.error(e);
    }
  }

  /**
   * fetch the amount of votes casted by a given address for a given proposal
   * @param id - id of the proposal
   * @param userAddress - ethereum address
   * @returns votes - amount of votes (forVotes - againstVotes for V2 contests ; votes for legacy contests)
   */
  async function fetchVotesPerAddress(id: number | string, userAddress: string) {
    const url = asPath.split("/");
    const chainId = chains.filter(chain => chain.name.toLowerCase().replace(" ", "") === url[2])?.[0]?.id;
    const address = url[3];
    const chainName = url[2];
    const abi = await getContestContractVersion(address, chainName);
    if (abi === null) {
      return;
    }

    try {
      const data = await readContract({
        //@ts-ignore
        addressOrName: address,
        contractInterface: abi,
        functionName: "proposalAddressVotes",
        args: [id, userAddress],
        chainId,
      });
      //@ts-ignore
      return data?.forVotes ? data?.forVotes / 1e18 - data?.againstVotes / 1e18 : data / 1e18;
    } catch (e) {
      console.error(e);
    }
  }

  /**
   * Format the contest data and create a CSV file with those data
   */
  async function formatContestCSVData() {
    stateExportData.setLoadingMessage("Formatting contest data, one moment...");
    stateExportData.setIsLoading(true);
    stateExportData.setIsSuccess(false);
    stateExportData.setCsv(null);
    stateExportData.setError(null, false);
    const contestAddress = asPath.split("/")[3]
    const chainName = asPath.split("/")[2]

    const propArrayToReturn = [];
    const tenthPercentile = Math.ceil(listProposalsIds.length / 10);
    const ensNamesMap = new Map();
    try {
      for (let i = 0; i < listProposalsIds.length; i++) {
        const propId = listProposalsIds[i];
        if (propId) {
          const propTotalVotes = listProposalsData[propId].votes;
          const propContent = listProposalsData[propId]?.content ?? "";
          const proposerAddress = listProposalsData[propId].authorEthereumAddress;
          const addressesVoted = await fetchProposalVoters(propId);
          if (!ensNamesMap.has(proposerAddress)) {
            // Keep a cache of ENS resolutions
            const ensResolve = await fetchEnsResolver({
              name: listProposalsData[propId].author,
              chainId: chain.mainnet.id,
            });
            const checkedResult = !ensResolve ? "No reverse record" : listProposalsData[propId].author;
            ensNamesMap.set(proposerAddress, checkedResult);
          }
          const proposerEnsLookupResult = ensNamesMap.get(proposerAddress);
          const COMMON_DATA = {
            [HEADERS_KEYS.PROPOSAL_ID]: propId,
            [HEADERS_KEYS.AUTHOR]: proposerAddress,
            [HEADERS_KEYS.PROPOSAL_CONTENT]: propContent,
            [HEADERS_KEYS.TOTAL_VOTES]: propTotalVotes,
          };

          //@ts-ignore
          if (addressesVoted.length == 0) {
            const noVoterDict = {
              ...COMMON_DATA,
              [HEADERS_KEYS.VOTER]: "No voters",
              [HEADERS_KEYS.VOTES]: "No votes",
              [HEADERS_KEYS.PERCENT_OF_SUBMISSION_VOTES]: 0,
              [HEADERS_KEYS.PROPOSER_HAS_ENS_REVERSE_RECORD_SET]:
                proposerEnsLookupResult === "No reverse record" ? false : true,
              [HEADERS_KEYS.PROPOSER_ENS_REVERSE_RECORD_IF_SET]:
                proposerEnsLookupResult === "No reverse record" ? "" : proposerEnsLookupResult,
              [HEADERS_KEYS.VOTER_HAS_ENS_REVERSE_RECORD_SET]: "No voters",
              [HEADERS_KEYS.VOTER_ENS_REVERSE_RECORD_IF_SET]: "",
            };

            propArrayToReturn.push(noVoterDict);
          }

          //@ts-ignore
          for (let j = 0; j < addressesVoted.length; j++) {
            //@ts-ignore
            const address = addressesVoted[j];
            const addressPropVote = await fetchVotesPerAddress(propId, address);
            if (!ensNamesMap.has(address)) {
              // Keep a cache of ENS resolutions
              const ensLookupResult = await fetchEnsName({
                address: address,
                chainId: chain.mainnet.id,
              });

              const checkedResult = ensLookupResult === null ? "No reverse record" : ensLookupResult;
              ensNamesMap.set(address, checkedResult);
            }
            const voterEnsLookupResult = ensNamesMap.get(address);

            const voterDict = {
              ...COMMON_DATA,
              [HEADERS_KEYS.VOTER]: address,
              [HEADERS_KEYS.VOTES]: addressPropVote,
              //@ts-ignore
              [HEADERS_KEYS.PERCENT_OF_SUBMISSION_VOTES]: addressPropVote / propTotalVotes,
              [HEADERS_KEYS.PROPOSER_HAS_ENS_REVERSE_RECORD_SET]:
                proposerEnsLookupResult == "No reverse record" ? false : true,
              [HEADERS_KEYS.PROPOSER_ENS_REVERSE_RECORD_IF_SET]:
                proposerEnsLookupResult == "No reverse record" ? "" : proposerEnsLookupResult,
              [HEADERS_KEYS.VOTER_HAS_ENS_REVERSE_RECORD_SET]:
                voterEnsLookupResult == "No reverse record" ? false : true,
              [HEADERS_KEYS.VOTER_ENS_REVERSE_RECORD_IF_SET]:
                voterEnsLookupResult == "No reverse record" ? "" : voterEnsLookupResult,
            };

            propArrayToReturn.push(voterDict);
          }

          if (i % tenthPercentile == 0) {
            stateExportData.setLoadingMessage(`Loading ${i} of ${listProposalsIds.length} entries...`);
          }
        }
      }

      stateExportData.setLoadingMessage(`Loaded ${listProposalsIds.length} out of ${listProposalsIds.length} entries!`);
      stateExportData.setCsv(propArrayToReturn);
      //@ts-ignore
      if (process.env.NEXT_PUBLIC_SUPABASE_URL !== '' && process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY !== '' && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
        if(queryContestResults.data?.length === 0) {
          const formatted = objectToCsv(propArrayToReturn)
          const csv = new File([formatted], `result_contest_${contestAddress}_${chainName}.csv`, { type: 'text/csv' });
    
          const config = await import('@config/supabase')
          const supabase = config.supabase
          const client = makeStorageClient()
          const cid = await client.put([csv])
          stateExportData.setCid(cid)

          await supabase.from("results").insert([
            {
              contest_address: contestAddress,
              contest_network_name: chainName,
              cid
            }
          ])
        }
      }
      stateExportData.setIsSuccess(true);
      stateExportData.setIsLoading(false);
    } catch (e) {
      console.error(e);
      stateExportData.setIsLoading(false);
      //@ts-ignore
      stateExportData.setError(e?.message ?? e, true);
    }
  }

  useEffect(() => {
    stateExportData.resetState();
  }, []);

  return {
    stateExportData,
    formatContestCSVData,
    queryContestResults,
  };
}
