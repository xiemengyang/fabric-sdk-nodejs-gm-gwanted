/**
 * Copyright 2017 IBM All Rights Reserved.
 *
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const utils = require('fabric-client/lib/utils.js');
const logger = utils.getLogger('connection profile');

const tape = require('tape');
const _test = require('tape-promise').default;
const test = _test(tape);

const Client = require('fabric-client');
const util = require('util');
const fs = require('fs');
const fsx = require('fs-extra');

const path = require('path');

const testUtil = require('../unit/util.js');


test('\n\n***** clean up the connection profile testing stores  *****\n\n', (t) => {
/*
	* The following is just testing housekeeping... cleanup from the last time
	* this test was run, a real application would not do this.
	*/
	const client = Client.loadFromConfig('test/fixtures/org1.yaml');
	let client_config = client.getClientConfig();

	let store_path = client_config.credentialStore.path;
	logger.debug('removing org1 credentialStore %s', store_path);
	fsx.removeSync(store_path);

	let crypto_path = client_config.credentialStore.cryptoStore.path;
	logger.debug('removing org1 cryptoStore %s', crypto_path);
	fsx.removeSync(crypto_path);

	client.loadFromConfig('test/fixtures/org2.yaml');
	client_config = client.getClientConfig();

	store_path = client_config.credentialStore.path;
	logger.debug('removing org2 credentialStore %s', store_path);
	fsx.removeSync(store_path);

	crypto_path = client_config.credentialStore.cryptoStore.path;
	logger.debug('removing org2 cryptoStore %s', crypto_path);
	fsx.removeSync(crypto_path);

	t.pass('Successfully removed all connection profile stores from previous testing');

	t.end();
});

test('\n\n***** use the connection profile file  *****\n\n', async (t) => {
	const channel_name = 'mychannel2';
	testUtil.resetDefaults();

	// build a 'Client' instance that knows the connection profile
	//  this connection profile does not have the client information, we will
	//  load that later so that we can switch this client to be in a different
	//  organization.
	const client_org1 = Client.loadFromConfig('test/fixtures/network.yaml');
	const client_org2 = Client.loadFromConfig('test/fixtures/network.yaml');
	t.pass('Successfully loaded a connection profile');

	let config = null;
	const signatures = [];
	let genesis_block = null;
	let channel_on_org1 = null;
	let channel_on_org2 = null;
	let query_tx_id = null;
	let instansiate_tx_id = null;

	// Load the client information for an organization.
	// The file only has the client section.
	// A real application might do this when a new user logs in.
	client_org1.loadFromConfig('test/fixtures/org1.yaml');
	client_org2.loadFromConfig('test/fixtures/org2.yaml');

	try {
		// tell this client instance where the state and key stores are located
		await client_org1.initCredentialStores();
		t.pass('Successfully created the key value store and crypto store based on the sdk config and connection profile');

		// get the CA associated with this client's organization
		let caService = client_org1.getCertificateAuthority();
		t.equals(caService.fabricCAServices._fabricCAClient._caName, 'ca-org1', 'checking that caname is correct after resetting the config');

		let request = {
			enrollmentID: 'admin',
			enrollmentSecret: 'adminpw',
			profile: 'tls'
		};
		let enrollment = await caService.enroll(request);
		t.pass('Successfully called the CertificateAuthority to get the TLS material');
		let key = enrollment.key.toBytes();
		let cert = enrollment.certificate;

		// set the material on the client to be used when building endpoints for the user
		client_org1.setTlsClientCertAndKey(cert, key);

		// tell this client instance where the state and key stores are located
		await client_org2.initCredentialStores();
		t.pass('Successfully created the key value store and crypto store based on the sdk config and connection profile');

		// get the CA associated with this client's organization
		caService = client_org2.getCertificateAuthority();
		t.equals(caService.fabricCAServices._fabricCAClient._caName, 'ca-org2', 'checking that caname is correct after resetting the config');
		request = {
			enrollmentID: 'admin',
			enrollmentSecret: 'adminpw',
			profile: 'tls'
		};
		enrollment = await caService.enroll(request);
		t.pass('Successfully called the CertificateAuthority to get the TLS material');
		key = enrollment.key.toBytes();
		cert = enrollment.certificate;

		// set the material on the client to be used when building endpoints for the user
		client_org2.setTlsClientCertAndKey(cert, key);

		// get the config envelope created by the configtx tool
		const envelope_bytes = fs.readFileSync(path.join(__dirname, '../fixtures/channel/mychannel2.tx'));
		// have the sdk get the config update object from the envelope generated by configtxgen
		// the config update object is what is required to be signed by all
		// participating organizations
		config = client_org1.extractChannelConfig(envelope_bytes);
		t.pass('Successfully extracted the config update from the configtx envelope');

		// Sign the config bytes
		// ---- the signChannelConfig() will have the admin identity sign the
		//      config if the client instance has been assigned an admin otherwise
		//      it will use the currently user context assigned. When loading a
		//      connection profile that has a client section that also has
		//      an admin defined for the organization defined in that client
		//      section it will be automatically assigned to the client instance.
		const signature1 = client_org1.signChannelConfig(config);
		// convert signature to a storable string
		// fabric-client SDK will convert any strings it finds back
		// to GRPC protobuf objects during the channel create
		const string_signature1 = signature1.toBuffer().toString('hex');
		t.pass('Successfully signed config update by org1');
		// collect signature from org1 admin
		signatures.push(string_signature1);

		// sign the config by admin from org2
		const signature2 = client_org2.signChannelConfig(config);
		t.pass('Successfully signed config update for org2');

		// collect the signature from org2's admin
		signatures.push(signature2);

		// now we have enough signatures...

		// get an admin based transaction
		// in this case we are assuming that the connection profile
		// has an admin defined for the current organization defined in the
		// client part of the connection profile, otherwise the setAdminSigningIdentity()
		// method would need to be called to setup the admin. If no admin is in the config
		// or has been assigned the transaction will based on the current user.
		let tx_id = client_org2.newTransactionID(true);
		// build up the create request
		request = {
			config: config,
			signatures: signatures,
			name: channel_name,
			orderer: 'orderer.example.com', //this assumes we have loaded a connection profile
			txId: tx_id
		};

		// send create request to orderer
		const result = await client_org2.createChannel(request); //admin from org2
		logger.debug('\n***\n completed the create \n***\n');

		logger.debug(' response ::%j', result);
		t.pass('Successfully created the channel.');
		if (result.status && result.status === 'SUCCESS') {
			await testUtil.sleep(10000);
		} else {
			t.fail('Failed to create the channel. ');
			throw new Error('Failed to create the channel. ');
		}
		t.pass('Successfully waited to make sure new channel was created on orderer.');

		// have the clients build a channel with all peers and orderers
		channel_on_org1 = client_org1.getChannel(channel_name);
		channel_on_org2 = client_org2.getChannel(channel_name);

		// get an admin based transaction
		tx_id = client_org2.newTransactionID(true);
		request = {
			txId: tx_id
		};

		const block = await channel_on_org2.getGenesisBlock(request); //admin from org2
		t.pass('Successfully got the genesis block');
		genesis_block = block;

		tx_id = client_org2.newTransactionID(true);
		request = {
			/**
			 * targets: this time we will leave blank so that we can use
			 *          all the peers assigned to the channel ...some may fail
			 *          if the submitter is not allowed, let's see what we get
			 */
			block: genesis_block,
			txId: tx_id
		};

		let results = await channel_on_org2.joinChannel(request); //admin from org2
		logger.debug(util.format('Join Channel R E S P O N S E using default targets: %j', results));

		// first of the results should not have good status as submitter does not have permission
		if (results && results[0] && results[0].response && results[0].response.status == 200) {
			t.fail(util.format('Successfully had peer in organization %s join the channel', 'org1'));
			throw new Error('Should not have been able to join channel with this submitter');
		} else {
			t.pass(' Submitter on "org2" Failed to have peer on org1 channel');
		}

		// second of the results should have good status
		if (results && results[1] && results[1].response && results[1].response.status == 200) {
			t.pass(util.format('Successfully had peer in organization %s join the channel', 'org2'));
		} else {
			t.fail(' Failed to join channel');
			throw new Error('Failed to join channel');
		}


		tx_id = client_org1.newTransactionID(true);
		request = {
			// this does assume that we have loaded a
			// connection profile with a peer by this name
			targets: ['peer0.org1.example.com'],
			block: genesis_block,
			txId: tx_id
		};

		results = await channel_on_org1.joinChannel(request);
		logger.debug(util.format('Join Channel R E S P O N S E  for a string target: %j', results));

		if (results && results[0] && results[0].response && results[0].response.status == 200) {
			t.pass(util.format('Successfully had peer in organization %s join the channel', 'org1'));
		} else {
			t.fail(' Failed to join channel on org1');
			throw new Error('Failed to join channel on org1');
		}
		await testUtil.sleep(10000);
		t.pass('Successfully waited for peers to join the channel');

		process.env.GOPATH = path.join(__dirname, '../fixtures');
		tx_id = client_org1.newTransactionID(true);
		// send proposal to endorser
		request = {
			//targets: get peers for this clients organization based on channel id
			channelNames: channel_name,
			chaincodePath: 'github.com/example_cc',
			chaincodeId: 'example',
			chaincodeVersion: 'v1',
			chaincodePackage: '',
			txId: tx_id
		};

		results = await client_org1.installChaincode(request);
		if (results && results[0] && results[0][0].response && results[0][0].response.status == 200) {
			t.pass('Successfully installed chain code on org1');
		} else {
			t.fail(' Failed to install chaincode on org1');
			throw new Error('Failed to install chain code on org1');
		}

		tx_id = client_org2.newTransactionID(true); // be sure to get a admin transaction ID
		// send proposal to endorser
		request = {
			targets: ['peer0.org2.example.com'],
			chaincodePath: 'github.com/example_cc',
			chaincodeId: 'example',
			chaincodeVersion: 'v1',
			chaincodePackage: '',
			txId: tx_id
		};

		results = await client_org2.installChaincode(request);
		if (results && results[0] && results[0][0].response && results[0][0].response.status == 200) {
			t.pass('Successfully installed chain code on org2');
		} else {
			t.fail(' Failed to install chaincode');
			throw new Error('Failed to install chain code');
		}

		/*
		*  I N S T A N S I A T E
		*/

		tx_id = client_org1.newTransactionID(true);
		instansiate_tx_id = tx_id;
		request = {
			chaincodeId: 'example',
			chaincodeVersion: 'v1',
			args: ['a', '100', 'b', '200'],
			txId: tx_id
			// targets is not required, however the logged in user may not have
			// admin access to all the peers defined in the connection profile
			//targets: ['peer0.org1.example.com'],
		};

		results = await channel_on_org1.sendInstantiateProposal(request);
		let proposalResponses = results[0];
		let proposal = results[1];
		let response;
		if (proposalResponses && proposalResponses[0].response && proposalResponses[0].response.status === 200) {
			t.pass('Successfully sent Proposal and received ProposalResponse');
			request = {
				proposalResponses: proposalResponses,
				proposal: proposal,
				txId: instansiate_tx_id //required to indicate that this is an admin transaction
				//orderer : not specifying, the first orderer defined in the
				//          connection profile for this channel will be used
			};

			response = await channel_on_org1.sendTransaction(request);
		} else {
			t.fail('Failed to send  Proposal or receive valid response. Response null or status is not 200. exiting...');
			throw new Error('Failed to send Proposal or receive valid response. Response null or status is not 200. exiting...');
		}
		if (!(response instanceof Error) && response.status === 'SUCCESS') {
			t.pass('Successfully sent transaction to instantiate the chaincode to the orderer.');
			await testUtil.sleep(10000);
		} else {
			t.fail('Failed to order the transaction to instantiate the chaincode. Error code: ' + response.status);
			throw new Error('Failed to order the transaction to instantiate the chaincode. Error code: ' + response.status);
		}
		t.pass('Successfully waited for chaincode to startup');

		// this will enroll the user using the ca as defined in the connection profile
		// for this organization and then set in on the client as the current user context
		const admin = await client_org1.setUserContext({ username: 'admin', password: 'adminpw' });
		t.pass('Successfully enrolled user \'admin\' for org1');

		const ca1 = client_org1.getCertificateAuthority();
		const secret = await ca1.register({ enrollmentID: 'user1', affiliation: 'org1' }, admin);
		t.pass('Successfully registered user \'user1\' for org1');

		await client_org1.setUserContext({ username: 'user1', password: secret });
		t.pass('Successfully enrolled user \'user1\' for org1');

		// try again ...this time use a longer timeout
		tx_id = client_org1.newTransactionID(); // get a non admin transaction ID
		query_tx_id = tx_id.getTransactionID(); //save transaction string for later
		request = {
			chaincodeId: 'example',
			fcn: 'move',
			args: ['a', 'b', '100'],
			txId: tx_id
			//targets - Letting default to all endorsing peers defined on the channel in the connection profile
		};

		results = await channel_on_org1.sendTransactionProposal(request); //logged in as org1 user
		proposalResponses = results[0];
		proposal = results[1];
		let all_good = true;
		// Will check to be sure that we see two responses as there are two peers defined on this
		// channel that are endorsing peers
		let endorsed_responses = 0;
		for (const i in proposalResponses) {
			let one_good = false;
			endorsed_responses++;
			const proposal_response = proposalResponses[i];
			if (proposal_response.response && proposal_response.response.status === 200) {
				t.pass('transaction proposal has response status of good');
				one_good = true;
			} else {
				t.fail('transaction proposal was bad');
				if (proposal_response.response && proposal_response.response.status) {
					t.comment(' response status:' + proposal_response.response.status +
						' message:' + proposal_response.response.message);
				} else {
					t.fail('transaction response was unknown');
					logger.error('transaction response was unknown %s', proposal_response);
				}
			}
			all_good = all_good & one_good;
		}
		t.equals(endorsed_responses, 2, 'Checking that there are the correct number of endorsed responses');
		if (!all_good) {
			t.fail('Failed to send invoke Proposal or receive valid response. Response null or status is not 200. exiting...');
			throw new Error('Failed to send invoke Proposal or receive valid response. Response null or status is not 200. exiting...');
		}
		request = {
			proposalResponses: proposalResponses,
			proposal: proposal,
			admin: true
		};

		const promises = [];

		// be sure to get an channel event hub the current user is authorized to use
		const eventhub = channel_on_org1.newChannelEventHub('peer0.org1.example.com');

		const txPromise = new Promise((resolve, reject) => {
			const handle = setTimeout(() => {
				eventhub.unregisterTxEvent(query_tx_id);
				eventhub.disconnect();
				t.fail('REQUEST_TIMEOUT --- eventhub did not report back');
				reject(new Error('REQUEST_TIMEOUT:' + eventhub._ep._endpoint.addr));
			}, 30000);

			eventhub.registerTxEvent(query_tx_id, (tx, code, block_num) => {
				clearTimeout(handle);
				if (code !== 'VALID') {
					t.fail('transaction was invalid, code = ' + code + ' with block_num ' + block_num);
					reject(new Error('INVALID:' + code));
				} else {
					t.pass('transaction has been committed on peer ' + eventhub.getPeerAddr());
					resolve('COMMITTED');
				}
			}, (error) => {
				clearTimeout(handle);
				t.fail('transaction event failed:' + error);
				reject(error);
			},
			{ disconnect: true } //since this is a test and we will not be using later
			);
		});
		// connect(true) to receive full blocks (user must have read rights to the channel)
		// should connect after registrations so that there is an error callback
		// to receive errors if there is a problem on the connect.
		eventhub.connect(true);

		promises.push(txPromise);
		promises.push(channel_on_org1.sendTransaction(request));

		results = await Promise.all(promises);
		const sendTransaction_results = results[1];// Promise all will return the results in order of the of Array
		if (sendTransaction_results instanceof Error) {
			t.fail('Failed to order the transaction: ' + sendTransaction_results);
			throw sendTransaction_results;
		} else if (sendTransaction_results.status === 'SUCCESS') {
			t.pass('Successfully sent transaction to invoke the chaincode to the orderer.');
		} else {
			t.fail('Failed to order the transaction to invoke the chaincode. Error code: ' + sendTransaction_results.status);
			throw new Error('Failed to order the transaction to invoke the chaincode. Error code: ' + sendTransaction_results.status);
		}

		await new Promise((resolve, reject) => {
			// get a new ChannelEventHub when registering a listener
			// with startBlock or endBlock when doing a replay
			// The ChannelEventHub must not have been connected or have other
			// listeners.
			const channel_event_hub = channel_on_org1.newChannelEventHub('peer0.org1.example.com');

			const handle = setTimeout(() => {
				t.fail('Timeout - Failed to receive replay the event for event1');
				channel_event_hub.unregisterTxEvent(query_tx_id);
				channel_event_hub.disconnect(); //shutdown down since we are done
			}, 10000);

			channel_event_hub.registerTxEvent(query_tx_id,
				(txnid, code, block_num) => {
					clearTimeout(handle);
					t.pass('Event has been replayed with transaction code:' + code + ' for transaction id:' + txnid + ' for block_num:' + block_num);
					resolve('Got the replayed transaction');
				}, (error) => {
					clearTimeout(handle);
					t.fail('Failed to receive event replay for Event for transaction id ::' + query_tx_id);
					reject(error);
				},
				// a real application would have remembered the last block number
				// received and used that value to start the replay
				// Setting the disconnect to true as we do not want to use this
				// ChannelEventHub after the event we are looking for comes in
				{ startBlock: 0, disconnect: true }
			);
			t.pass('Successfully registered transaction replay for ' + query_tx_id);

			channel_event_hub.connect(); //connect to receive filtered blocks
			t.pass('Successfully called connect on the transaction replay event hub for filtered blocks');
		});
		t.pass('Successfully checked channel event hub replay');

		await new Promise((resolve, reject) => {
			// Get the list of channel event hubs for the current organization.
			// These will be peers with the "eventSource" role setting of true
			// and not the peers that have an "eventURL" defined. Peers with the
			// eventURL defined are peers with the legacy Event Hub that is on
			// a different port than the peer services. The peers with the
			// "eventSource" tag are running the channel-based event service
			// on the same port as the other peer services.
			const channel_event_hubs = channel_on_org1.getChannelEventHubsForOrg();
			// we should have the an channel event hub defined on the "peer0.org1.example.com"
			t.equals(channel_event_hubs.length, 1, 'Checking that the channel event hubs has 1');

			const channel_event_hub = channel_event_hubs[0];
			t.equals(channel_event_hub.getPeerAddr(), 'localhost:7051', ' channel event hub address ');

			const handle = setTimeout(() => {
				t.fail('Timeout - Failed to receive replay the event for event1');
				channel_event_hub.unregisterTxEvent(query_tx_id);
				channel_event_hub.disconnect(); //shutdown down since we are done
			}, 10000);

			channel_event_hub.registerTxEvent(query_tx_id,
				(txnid, code, block_num) => {
					clearTimeout(handle);
					t.pass('Event has been replayed with transaction code:' + code + ' for transaction id:' + txnid + ' for block_num:' + block_num);
					resolve('Got the replayed transaction');
				}, (error) => {
					clearTimeout(handle);
					t.fail('Failed to receive event replay for Event for transaction id ::' + query_tx_id);
					reject(error);
				},
				// a real application would have remembered the last block number
				// received and used that value to start the replay
				// Setting the disconnect to true as we do not want to use this
				// ChannelEventHub after the event we are looking for comes in
				{ startBlock: 0, disconnect: true }
			);
			t.pass('Successfully registered transaction replay for ' + query_tx_id);

			channel_event_hub.connect(); //connect to receive filtered blocks
			t.pass('Successfully called connect on the transaction replay event hub for filtered blocks');
		});
		t.pass('Successfully checked replay');
		// check that we can get the user again without password
		// also verifies that we can get a complete user properly stored
		// when using a connection profile
		await client_org1.setUserContext({ username: 'admin' });
		t.pass('Successfully loaded user \'admin\' from store for org1');

		request = {
			chaincodeId: 'example',
			fcn: 'query',
			args: ['b']
		};

		const response_payloads = await channel_on_org1.queryByChaincode(request); //logged in as user on org1
		// should only be one response ...as only one peer is defined as CHAINCODE_QUERY_ROLE
		let query_responses = 0;
		if (response_payloads) {
			for (let i = 0; i < response_payloads.length; i++) {
				query_responses++;
				t.equal(
					response_payloads[i].toString('utf8'),
					'300',
					'checking query results are correct that user b has 300 now after the move');
			}
		} else {
			t.fail('response_payloads is null');
			throw new Error('Failed to get response on query');
		}
		t.equals(query_responses, 1, 'Checking that only one response was seen');

		results = await client_org1.queryChannels('peer0.org1.example.com');
		logger.debug(' queryChannels ::%j', results);
		let found = false;
		for (const i in results.channels) {
			logger.debug(' queryChannels has found %s', results.channels[i].channel_id);
			if (results.channels[i].channel_id === channel_name) {
				found = true;
			}
		}
		if (found) {
			t.pass('Successfully found our channel in the result list');
		} else {
			t.fail('Failed to find our channel in the result list');
		}

		results = await client_org1.queryInstalledChaincodes('peer0.org1.example.com', true); // use admin
		logger.debug(' queryInstalledChaincodes ::%j', results);
		found = false;
		for (const i in results.chaincodes) {
			logger.debug(' queryInstalledChaincodes has found %s', results.chaincodes[i].name);
			if (results.chaincodes[i].name === 'example') {
				found = true;
			}
		}
		if (found) {
			t.pass('Successfully found our chaincode in the result list');
		} else {
			t.fail('Failed to find our chaincode in the result list');
		}

		results = await channel_on_org1.queryBlock(1);
		logger.debug(' queryBlock ::%j', results);
		t.equals('1', results.header.number, 'Should be able to find our block number');

		results = await channel_on_org1.queryInfo();
		logger.debug(' queryInfo ::%j', results);
		t.equals(3, results.height.low, 'Should be able to find our block height');

		results = await channel_on_org1.queryBlockByHash(results.previousBlockHash);
		logger.debug(' queryBlockHash ::%j', results);
		t.equals('1', results.header.number, 'Should be able to find our block number by hash');

		results = await channel_on_org1.queryTransaction(query_tx_id);
		logger.debug(' queryTransaction ::%j', results);
		t.equals(0, results.validationCode, 'Should be able to find our transaction validationCode');

		results = await channel_on_org1.queryBlock(1, 'peer0.org1.example.com');
		logger.debug(' queryBlock ::%j', results);
		t.equals('1', results.header.number, 'Should be able to find our block number with string peer name');

		results = await channel_on_org1.queryInfo('peer0.org1.example.com');
		logger.debug(' queryInfo ::%j', results);
		t.equals(3, results.height.low, 'Should be able to find our block height with string peer name');

		results = await channel_on_org1.queryBlockByHash(results.previousBlockHash, 'peer0.org1.example.com');
		logger.debug(' queryBlockHash ::%j', results);
		t.equals('1', results.header.number, 'Should be able to find our block number by hash with string peer name');

		results = await channel_on_org1.queryTransaction(query_tx_id, 'peer0.org1.example.com');
		logger.debug(' queryTransaction ::%j', results);
		t.equals(0, results.validationCode, 'Should be able to find our transaction validationCode with string peer name');

		results = await channel_on_org1.queryBlock(1, 'peer0.org1.example.com', true);
		logger.debug(' queryBlock ::%j', results);
		t.equals('1', results.header.number, 'Should be able to find our block number by admin');

		results = await channel_on_org1.queryInfo('peer0.org1.example.com', true);
		logger.debug(' queryInfo ::%j', results);
		t.equals(3, results.height.low, 'Should be able to find our block height by admin');

		results = await channel_on_org1.queryBlockByHash(results.previousBlockHash, 'peer0.org1.example.com', true);
		logger.debug(' queryBlockHash ::%j', results);
		t.equals('1', results.header.number, 'Should be able to find our block number by hash by admin');

		results = await channel_on_org1.queryTransaction(query_tx_id, 'peer0.org1.example.com', true);
		logger.debug(' queryTransaction ::%j', results);
		t.equals(0, results.validationCode, 'Should be able to find our transaction validationCode by admin');

		tx_id = client_org1.newTransactionID(); // get a non admin transaction ID
		request = {
			chaincodeId: 'example',
			fcn: 'move',
			args: ['a', 'b', '100'],
			txId: tx_id
			//targets - Letting default to all endorsing peers defined on the channel in the connection profile
		};

		// put in a very small timeout to force a failure, thereby checking that the timeout value was being used
		results = await channel_on_org1.sendTransactionProposal(request, 1); //logged in as org1 user
		proposalResponses = results[0];
		for (const i in proposalResponses) {
			const proposal_response = proposalResponses[i];
			if (proposal_response instanceof Error && proposal_response.toString().indexOf('REQUEST_TIMEOUT') > 0) {
				t.pass('Successfully cause a timeout error by setting the timeout setting to 1');
			} else {
				t.fail('Failed to get the timeout error');
			}
		}

		t.pass('Testing has completed successfully');
	} catch (error) {
		logger.error('catch connection profile test error:: %s', error.stack ? error.stack : error);
		t.fail('Test failed with ' + error);
	}
	t.end();
});

test('\n\n***** Enroll user and set user context using a specified caName *****\n\n', async (t) => {
	try {
		// ca_name and org_name must match network configuration
		const ca_name = 'ca-org1';
		const org_name = 'org1';
		const testuser = 'test_caname';

		testUtil.resetDefaults();

		// Build a 'Client' instance that knows the network
		// then load org1.yaml to the same instance
		const client_org1 = Client.loadFromConfig('test/fixtures/network.yaml');
		client_org1.loadFromConfig('test/fixtures/org1.yaml');
		t.pass('Successfully loaded client section of network config');

		// tell this client instance where the state and key stores are located
		await client_org1.initCredentialStores();
		t.pass('Successfully created the key value store  and crypto store based on the config and network config');

		const caService = client_org1.getCertificateAuthority();
		t.equals(caService.fabricCAServices._fabricCAClient._caName, ca_name, 'checking that caname is correct after resetting the config');

		const admin = await client_org1.setUserContext({ username: 'admin', password: 'adminpw' });
		t.pass('Successfully set user context \'admin\' for ' + org_name);

		// register another user and enroll it with a specified caName
		const ca1 = client_org1.getCertificateAuthority();
		const secret = await ca1.register({ enrollmentID: testuser, affiliation: org_name }, admin);
		t.pass('Successfully registerred user ' + testuser + ' for ' + org_name);

		await client_org1.setUserContext({ username: testuser, password: secret, caName: ca_name });
		t.pass('Successfully enrolled user and set user context using username, password, and caName');

		let user = await client_org1.getUserContext();
		if (user && user.getName() === testuser) {
			t.pass('Successfully get user from context');
		} else {
			t.fail('Failed to get user from context');
		}

		// register another user and enroll it without a caName. SDK will pick the first CA on the list
		const testuser2 = testuser + '2';
		const secret2 = await ca1.register({ enrollmentID: testuser2, affiliation: org_name }, admin);
		t.pass('Successfully registerred user ' + testuser2 + ' for ' + org_name);

		await client_org1.setUserContext({ username: testuser2, password: secret2 });
		t.pass('Successfully enrolled user and set user context using username and password');

		user = await client_org1.getUserContext(testuser2);
		if (user) {
			t.pass('Successfully get user context for the specified username');
		} else {
			t.fail('Failed to get user context for the specified username');
		}
	} catch (err) {
		logger.error(err);
		t.fail('Got unexpected error when testing setUserContext with caName. Error: ' + err.message);
	}

	t.end();
});

test('\n\n***** Enroll user and set user context using a bad caName *****\n\n', async (t) => {
	try {
		// ca_name and org_name must match network configuration
		const ca_name = 'ca-org1';
		const ca_bad_name = 'ca-badname'; // non existent ca
		const ca_wrong_name = 'ca-org2'; // ca in another org
		const org_name = 'org1';
		const testuser = 'user_ca_badname';

		testUtil.resetDefaults();

		// Build a 'Client' instance that knows the network
		// then load org1.yaml to the same instance
		const client_org1 = Client.loadFromConfig('test/fixtures/network.yaml');
		client_org1.loadFromConfig('test/fixtures/org1.yaml');
		t.pass('Successfully loaded client section of network config');

		// tell this client instance where the state and key stores are located
		await client_org1.initCredentialStores();
		t.pass('Successfully created the key value store  and crypto store based on the config and network config');

		const caService = client_org1.getCertificateAuthority();
		t.equals(caService.fabricCAServices._fabricCAClient._caName, ca_name, 'checking that caname is correct after resetting the config');

		const admin = await client_org1.setUserContext({ username: 'admin', password: 'adminpw' });
		t.pass('Successfully set user context \'admin\' for ' + org_name);

		const ca1 = client_org1.getCertificateAuthority();
		const secret = await ca1.register({ enrollmentID: testuser, affiliation: org_name }, admin);

		try {
			await client_org1.setUserContext({ username: testuser, password: secret, caName: ca_bad_name });
			t.fail('Should throw error when setting user context using a bad caName');
		} catch (err) {
			// Expected error should include missing this client\'s organization and certificate authority
			t.equal(err.message.includes('missing this client\'s organization and certificate authority'), true,
				'Got expected error to enroll user using a bad caName. Error: ' + err.message);
		}

		try {
			await client_org1.setUserContext({ username: testuser, password: secret, caName: ca_wrong_name });
			t.fail('Should throw error when setting user context using a caName in another org');
		} catch (err) {
			// Expected error should include Authorization failure or Authentication failure
			t.equal(err.message.includes('failure'), true,
				'Got expected error to enroll user using a caName in another org. Error: ' + err.message);
		}
	} catch (err) {
		t.fail('Got unexpected error when testing setUserContext with bad caName. Error: ' + err.message);
	}

	t.end();
});