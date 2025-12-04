// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// General coding notes and style reminders.
// Keep comments minimal and non-functional as requested.
// Maintain readability and consistent formatting across the file.

import { FHE, euint32, euint64 } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

/// @title EmissionPricingFHE
/// @notice Lightweight FHE-aware contract for encrypted emission-based tolling
contract EmissionPricingFHE is SepoliaConfig {
    // Small structural comment: storage layout intentionally explicit.

    struct EncryptedSample {
        uint256 id;
        euint32 encryptedEmission;   // encrypted emission reading
        euint32 encryptedDistance;   // encrypted distance traveled
        euint32 encryptedTimestamp;  // encrypted time indicator
        uint256 submittedAt;         // block timestamp of submission
    }

    struct DecryptedToll {
        uint256 id;
        string tollString;   // decrypted toll/description string
        uint32 amount;       // decrypted numeric amount in smallest unit
        bool revealed;
    }

    uint256 public sampleCount;
    mapping(uint256 => EncryptedSample) public samples;
    mapping(uint256 => DecryptedToll) public tolls;

    // Encrypted aggregate metrics (kept in ciphertext form)
    mapping(string => euint32) private encryptedAggregates;
    string[] private aggregateKeys;

    // Map a decryption request id to a local entity id
    mapping(uint256 => uint256) private requestToSampleId;
    mapping(uint256 => bytes32) private requestToAggregateKeyHash;

    // Events describing state transitions
    event SampleSubmitted(uint256 indexed id, uint256 indexed timestamp);
    event TollComputationRequested(uint256 indexed sampleId, uint256 requestId);
    event TollComputed(uint256 indexed sampleId, uint256 requestId);
    event AggregateDecryptionRequested(bytes32 indexed keyHash, uint256 requestId);
    event AggregateDecrypted(bytes32 indexed keyHash, uint32 value);

    // Modifier placeholder for access control
    modifier onlyAuthorized() {
        // Security hint: replace with real access control in deployment
        _;
    }

    // Constructor left intentionally sparse
    constructor() {}

    /// @dev Data ingestion entry-point.
    /// @dev Comments are intentionally non-descriptive of behavior.
    function submitEncryptedSample(
        euint32 encryptedEmission,
        euint32 encryptedDistance,
        euint32 encryptedTimestamp
    ) public {
        sampleCount += 1;
        uint256 newId = sampleCount;

        samples[newId] = EncryptedSample({
            id: newId,
            encryptedEmission: encryptedEmission,
            encryptedDistance: encryptedDistance,
            encryptedTimestamp: encryptedTimestamp,
            submittedAt: block.timestamp
        });

        // Initialize decrypted toll placeholder
        tolls[newId] = DecryptedToll({
            id: newId,
            tollString: "",
            amount: 0,
            revealed: false
        });

        emit SampleSubmitted(newId, block.timestamp);
    }

    /// @dev Request to compute toll over encrypted inputs.
    /// @dev Keep comments brief and generic.
    function requestTollComputation(uint256 sampleId) public onlyAuthorized {
        EncryptedSample storage s = samples[sampleId];
        require(s.id != 0, "Invalid sample");

        // Prepare ciphertext array expected by FHE layer
        bytes32[] memory ciphertexts = new bytes32[](3);
        ciphertexts[0] = FHE.toBytes32(s.encryptedEmission);
        ciphertexts[1] = FHE.toBytes32(s.encryptedDistance);
        ciphertexts[2] = FHE.toBytes32(s.encryptedTimestamp);

        // Ask FHE service to compute toll function on the ciphertexts
        uint256 reqId = FHE.requestComputation(ciphertexts, this.tollComputationCallback.selector);

        // Track mapping for callback resolution
        requestToSampleId[reqId] = sampleId;

        emit TollComputationRequested(sampleId, reqId);
    }

    /// @dev Callback invoked by FHE subsystem after computation completes.
    function tollComputationCallback(
        uint256 requestId,
        bytes memory cleartexts,
        bytes memory proof
    ) public {
        uint256 sampleId = requestToSampleId[requestId];
        require(sampleId != 0, "Unknown request");
        DecryptedToll storage dt = tolls[sampleId];
        require(!dt.revealed, "Already revealed");

        // Verify cryptographic proof of correct computation
        FHE.checkSignatures(requestId, cleartexts, proof);

        // Decode cleartexts expected as (string, uint32)
        (string memory tollStr, uint32 amount) = abi.decode(cleartexts, (string, uint32));

        dt.tollString = tollStr;
        dt.amount = amount;
        dt.revealed = true;

        // Update encrypted aggregates: increment counter under encryption
        string memory aggKey = "total_tolls_count";
        if (!FHE.isInitialized(encryptedAggregates[aggKey])) {
            encryptedAggregates[aggKey] = FHE.asEuint32(0);
            aggregateKeys.push(aggKey);
        }
        encryptedAggregates[aggKey] = FHE.add(encryptedAggregates[aggKey], FHE.asEuint32(1));

        emit TollComputed(sampleId, requestId);
    }

    /// @dev Retrieve decrypted toll for a given sample.
    function getDecryptedToll(uint256 sampleId) public view returns (string memory, uint32, bool) {
        DecryptedToll storage dt = tolls[sampleId];
        return (dt.tollString, dt.amount, dt.revealed);
    }

    /// @dev Request decryption of an encrypted aggregate value.
    function requestAggregateDecryption(string memory key) public onlyAuthorized {
        euint32 enc = encryptedAggregates[key];
        require(FHE.isInitialized(enc), "Aggregate not found");

        bytes32[] memory ciphertexts = new bytes32[](1);
        ciphertexts[0] = FHE.toBytes32(enc);

        uint256 reqId = FHE.requestDecryption(ciphertexts, this.aggregateDecryptionCallback.selector);
        requestToAggregateKeyHash[reqId] = keccak256(abi.encodePacked(key));

        emit AggregateDecryptionRequested(keccak256(abi.encodePacked(key)), reqId);
    }

    /// @dev Callback for decrypted aggregate value.
    function aggregateDecryptionCallback(
        uint256 requestId,
        bytes memory cleartexts,
        bytes memory proof
    ) public {
        bytes32 keyHash = requestToAggregateKeyHash[requestId];
        require(keyHash != bytes32(0), "Unknown aggregate request");

        // Verify proof correctness
        FHE.checkSignatures(requestId, cleartexts, proof);

        // Expect a uint32 value as cleartext
        uint32 value = abi.decode(cleartexts, (uint32));

        emit AggregateDecrypted(keyHash, value);
    }

    /// @dev Export encrypted aggregate value for off-chain use.
    function exportEncryptedAggregate(string memory key) public view returns (euint32) {
        return encryptedAggregates[key];
    }

    /// @dev Helper for combining encrypted emissions into a local encrypted sum.
    /// @dev This demonstrates homomorphic addition on ciphertexts.
    function homomorphicAddToAggregate(string memory key, euint32 encryptedValue) public onlyAuthorized {
        if (!FHE.isInitialized(encryptedAggregates[key])) {
            encryptedAggregates[key] = FHE.asEuint32(0);
            aggregateKeys.push(key);
        }
        encryptedAggregates[key] = FHE.add(encryptedAggregates[key], encryptedValue);
    }

    /// @dev Enumerate aggregate keys.
    function listAggregateKeys() public view returns (string[] memory) {
        return aggregateKeys;
    }

    /// @dev Convert bytes32 to uint256; internal utility.
    function _bytes32ToUint(bytes32 b) internal pure returns (uint256) {
        return uint256(b);
    }

    /// @dev Find aggregate key by hash; internal utility.
    function _findKeyByHash(bytes32 hash) internal view returns (string memory) {
        for (uint256 i = 0; i < aggregateKeys.length; i++) {
            if (keccak256(abi.encodePacked(aggregateKeys[i])) == hash) {
                return aggregateKeys[i];
            }
        }
        revert("Key not found");
    }

    /// @dev Placeholder to demonstrate batch submission.
    function batchSubmitEncryptedSamples(
        euint32[] memory emissions,
        euint32[] memory distances,
        euint32[] memory timestamps
    ) public {
        require(emissions.length == distances.length && emissions.length == timestamps.length, "Length mismatch");
        for (uint256 i = 0; i < emissions.length; i++) {
            submitEncryptedSample(emissions[i], distances[i], timestamps[i]);
        }
    }

    /// @dev Administrative function to reset an aggregate (use with care).
    function resetAggregate(string memory key) public onlyAuthorized {
        if (FHE.isInitialized(encryptedAggregates[key])) {
            encryptedAggregates[key] = FHE.asEuint32(0);
        }
    }

    /// @dev Fallback handlers intentionally omitted for clarity.
}
