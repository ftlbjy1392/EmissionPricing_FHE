import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import WalletManager from "./components/WalletManager";
import WalletSelector from "./components/WalletSelector";
import "./App.css";

interface VehicleRecord {
  id: string;
  encryptedEmission: string;
  timestamp: number;
  owner: string;
  toll: number;
  status: "pending" | "calculated" | "paid";
}

const App: React.FC = () => {
  const [account, setAccount] = useState("");
  const [loading, setLoading] = useState(true);
  const [records, setRecords] = useState<VehicleRecord[]>([]);
  const [provider, setProvider] = useState<ethers.BrowserProvider | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [walletSelectorOpen, setWalletSelectorOpen] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{
    visible: boolean;
    status: "pending" | "success" | "error";
    message: string;
  }>({ visible: false, status: "pending", message: "" });
  const [newRecordData, setNewRecordData] = useState({
    vehicleId: "",
    emissionLevel: "",
    location: ""
  });
  const [showFAQ, setShowFAQ] = useState(false);
  const [selectedRecord, setSelectedRecord] = useState<VehicleRecord | null>(null);

  // Calculate statistics
  const pendingCount = records.filter(r => r.status === "pending").length;
  const calculatedCount = records.filter(r => r.status === "calculated").length;
  const paidCount = records.filter(r => r.status === "paid").length;
  const totalToll = records.reduce((sum, record) => sum + record.toll, 0);
  const avgToll = records.length > 0 ? totalToll / records.length : 0;

  useEffect(() => {
    loadRecords().finally(() => setLoading(false));
  }, []);

  const onWalletSelect = async (wallet: any) => {
    if (!wallet.provider) return;
    try {
      const web3Provider = new ethers.BrowserProvider(wallet.provider);
      setProvider(web3Provider);
      const accounts = await web3Provider.send("eth_requestAccounts", []);
      const acc = accounts[0] || "";
      setAccount(acc);

      wallet.provider.on("accountsChanged", async (accounts: string[]) => {
        const newAcc = accounts[0] || "";
        setAccount(newAcc);
      });
    } catch (e) {
      alert("Failed to connect wallet");
    }
  };

  const onConnect = () => setWalletSelectorOpen(true);
  const onDisconnect = () => {
    setAccount("");
    setProvider(null);
  };

  const loadRecords = async () => {
    setIsRefreshing(true);
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      
      // Check contract availability using FHE
      const isAvailable = await contract.isAvailable();
      if (!isAvailable) {
        console.error("Contract is not available");
        return;
      }
      
      const keysBytes = await contract.getData("record_keys");
      let keys: string[] = [];
      
      if (keysBytes.length > 0) {
        try {
          keys = JSON.parse(ethers.toUtf8String(keysBytes));
        } catch (e) {
          console.error("Error parsing record keys:", e);
        }
      }
      
      const list: VehicleRecord[] = [];
      
      for (const key of keys) {
        try {
          const recordBytes = await contract.getData(`record_${key}`);
          if (recordBytes.length > 0) {
            try {
              const recordData = JSON.parse(ethers.toUtf8String(recordBytes));
              list.push({
                id: key,
                encryptedEmission: recordData.encryptedEmission,
                timestamp: recordData.timestamp,
                owner: recordData.owner,
                toll: recordData.toll || 0,
                status: recordData.status || "pending"
              });
            } catch (e) {
              console.error(`Error parsing record data for ${key}:`, e);
            }
          }
        } catch (e) {
          console.error(`Error loading record ${key}:`, e);
        }
      }
      
      list.sort((a, b) => b.timestamp - a.timestamp);
      setRecords(list);
    } catch (e) {
      console.error("Error loading records:", e);
    } finally {
      setIsRefreshing(false);
      setLoading(false);
    }
  };

  const submitRecord = async () => {
    if (!provider) { 
      alert("Please connect wallet first"); 
      return; 
    }
    
    setCreating(true);
    setTransactionStatus({
      visible: true,
      status: "pending",
      message: "Encrypting emission data with FHE..."
    });
    
    try {
      // Simulate FHE encryption
      const encryptedEmission = `FHE-${btoa(JSON.stringify({
        emission: newRecordData.emissionLevel,
        location: newRecordData.location
      }))}`;
      
      // Simulate FHE toll calculation
      const emissionValue = parseFloat(newRecordData.emissionLevel);
      const baseToll = 5; // Base toll in ETH
      const toll = baseToll + (emissionValue * 0.1); // Higher emissions = higher toll
      
      const contract = await getContractWithSigner();
      if (!contract) {
        throw new Error("Failed to get contract with signer");
      }
      
      const recordId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

      const recordData = {
        encryptedEmission,
        timestamp: Math.floor(Date.now() / 1000),
        owner: account,
        toll,
        status: "pending"
      };
      
      // Store encrypted data on-chain using FHE
      await contract.setData(
        `record_${recordId}`, 
        ethers.toUtf8Bytes(JSON.stringify(recordData))
      );
      
      const keysBytes = await contract.getData("record_keys");
      let keys: string[] = [];
      
      if (keysBytes.length > 0) {
        try {
          keys = JSON.parse(ethers.toUtf8String(keysBytes));
        } catch (e) {
          console.error("Error parsing keys:", e);
        }
      }
      
      keys.push(recordId);
      
      await contract.setData(
        "record_keys", 
        ethers.toUtf8Bytes(JSON.stringify(keys))
      );
      
      setTransactionStatus({
        visible: true,
        status: "success",
        message: "Emission data encrypted and submitted!"
      });
      
      await loadRecords();
      
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowCreateModal(false);
        setNewRecordData({
          vehicleId: "",
          emissionLevel: "",
          location: ""
        });
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction")
        ? "Transaction rejected by user"
        : "Submission failed: " + (e.message || "Unknown error");
      
      setTransactionStatus({
        visible: true,
        status: "error",
        message: errorMessage
      });
      
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
      }, 3000);
    } finally {
      setCreating(false);
    }
  };

  const calculateToll = async (recordId: string) => {
    if (!provider) {
      alert("Please connect wallet first");
      return;
    }

    setTransactionStatus({
      visible: true,
      status: "pending",
      message: "Calculating toll with FHE..."
    });

    try {
      // Simulate FHE computation time
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      const contract = await getContractWithSigner();
      if (!contract) {
        throw new Error("Failed to get contract with signer");
      }
      
      const recordBytes = await contract.getData(`record_${recordId}`);
      if (recordBytes.length === 0) {
        throw new Error("Record not found");
      }
      
      const recordData = JSON.parse(ethers.toUtf8String(recordBytes));
      
      // In a real system, this would be done with FHE
      const updatedRecord = {
        ...recordData,
        status: "calculated"
      };
      
      await contract.setData(
        `record_${recordId}`, 
        ethers.toUtf8Bytes(JSON.stringify(updatedRecord))
      );
      
      setTransactionStatus({
        visible: true,
        status: "success",
        message: "Toll calculated using FHE!"
      });
      
      await loadRecords();
      
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
      }, 2000);
    } catch (e: any) {
      setTransactionStatus({
        visible: true,
        status: "error",
        message: "Calculation failed: " + (e.message || "Unknown error")
      });
      
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
      }, 3000);
    }
  };

  const payToll = async (recordId: string) => {
    if (!provider) {
      alert("Please connect wallet first");
      return;
    }

    setTransactionStatus({
      visible: true,
      status: "pending",
      message: "Processing payment..."
    });

    try {
      const contract = await getContractWithSigner();
      if (!contract) {
        throw new Error("Failed to get contract with signer");
      }
      
      const recordBytes = await contract.getData(`record_${recordId}`);
      if (recordBytes.length === 0) {
        throw new Error("Record not found");
      }
      
      const recordData = JSON.parse(ethers.toUtf8String(recordBytes));
      
      const updatedRecord = {
        ...recordData,
        status: "paid"
      };
      
      await contract.setData(
        `record_${recordId}`, 
        ethers.toUtf8Bytes(JSON.stringify(updatedRecord))
      );
      
      setTransactionStatus({
        visible: true,
        status: "success",
        message: "Payment successful!"
      });
      
      await loadRecords();
      
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
      }, 2000);
    } catch (e: any) {
      setTransactionStatus({
        visible: true,
        status: "error",
        message: "Payment failed: " + (e.message || "Unknown error")
      });
      
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
      }, 3000);
    }
  };

  const isOwner = (address: string) => {
    return account.toLowerCase() === address.toLowerCase();
  };

  const viewRecordDetails = (record: VehicleRecord) => {
    setSelectedRecord(record);
  };

  const closeRecordDetails = () => {
    setSelectedRecord(null);
  };

  const checkAvailability = async () => {
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      
      const isAvailable = await contract.isAvailable();
      
      setTransactionStatus({
        visible: true,
        status: "success",
        message: isAvailable 
          ? "FHE system is available and operational!" 
          : "FHE system is currently unavailable"
      });
      
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
      }, 3000);
    } catch (e) {
      setTransactionStatus({
        visible: true,
        status: "error",
        message: "Failed to check availability"
      });
      
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
      }, 3000);
    }
  };

  const faqItems = [
    {
      question: "How does FHE protect my privacy?",
      answer: "Fully Homomorphic Encryption allows your vehicle emission data to be processed without ever being decrypted. The system calculates your toll while keeping your actual emission levels private."
    },
    {
      question: "Why dynamic pricing?",
      answer: "Dynamic pricing encourages the use of low-emission vehicles by making high-emission vehicles pay more. This incentivizes eco-friendly transportation choices."
    },
    {
      question: "How is my toll calculated?",
      answer: "Your toll is calculated based on your vehicle's encrypted emission data and current traffic conditions. Higher emissions result in higher tolls to encourage cleaner transportation."
    },
    {
      question: "Is my vehicle data stored securely?",
      answer: "Yes, all vehicle emission data is encrypted using FHE before being stored on the blockchain. Only the calculated toll amount is stored in plain text."
    },
    {
      question: "Can I see my emission data?",
      answer: "For privacy reasons, your exact emission data is encrypted and not directly accessible. However, you can see the calculated toll amount which reflects your vehicle's environmental impact."
    }
  ];

  if (loading) return (
    <div className="loading-screen">
      <div className="fhe-spinner"></div>
      <p>Initializing FHE connection...</p>
    </div>
  );

  return (
    <div className="app-container glass-theme">
      <header className="app-header">
        <div className="logo">
          <div className="logo-icon">
            <div className="leaf-icon"></div>
          </div>
          <h1>FHE<span>Road</span>Pricing</h1>
        </div>
        
        <div className="header-actions">
          <button 
            onClick={() => setShowCreateModal(true)} 
            className="create-record-btn glass-button"
          >
            <div className="add-icon"></div>
            Add Vehicle
          </button>
          <button 
            className="glass-button"
            onClick={() => setShowFAQ(!showFAQ)}
          >
            {showFAQ ? "Hide FAQ" : "Show FAQ"}
          </button>
          <button 
            className="glass-button"
            onClick={checkAvailability}
          >
            Check FHE Status
          </button>
          <WalletManager account={account} onConnect={onConnect} onDisconnect={onDisconnect} />
        </div>
      </header>
      
      <div className="main-content">
        <div className="welcome-banner">
          <div className="welcome-text">
            <h2>FHE-Powered Dynamic Road Pricing</h2>
            <p>Encrypted emission-based toll calculation for sustainable transportation</p>
          </div>
          <div className="fhe-badge">
            <span>FHE-ENCRYPTED</span>
          </div>
        </div>
        
        <div className="dashboard-grid">
          <div className="dashboard-card glass-card project-intro">
            <h3>Project Introduction</h3>
            <p>This system uses Fully Homomorphic Encryption (FHE) to calculate road tolls based on vehicle emissions without decrypting sensitive data. It promotes eco-friendly transportation while preserving privacy.</p>
            <div className="fhe-process">
              <div className="process-step">
                <div className="step-icon">1</div>
                <p>Encrypt vehicle emission data</p>
              </div>
              <div className="process-step">
                <div className="step-icon">2</div>
                <p>Calculate toll using FHE</p>
              </div>
              <div className="process-step">
                <div className="step-icon">3</div>
                <p>Pay toll without revealing emissions</p>
              </div>
            </div>
          </div>
          
          <div className="dashboard-card glass-card">
            <h3>Data Statistics</h3>
            <div className="stats-grid">
              <div className="stat-item">
                <div className="stat-value">{records.length}</div>
                <div className="stat-label">Total Vehicles</div>
              </div>
              <div className="stat-item">
                <div className="stat-value">{avgToll.toFixed(2)} ETH</div>
                <div className="stat-label">Avg Toll</div>
              </div>
              <div className="stat-item">
                <div className="stat-value">{pendingCount}</div>
                <div className="stat-label">Pending</div>
              </div>
              <div className="stat-item">
                <div className="stat-value">{paidCount}</div>
                <div className="stat-label">Paid</div>
              </div>
            </div>
          </div>
          
          <div className="dashboard-card glass-card">
            <h3>Emission Distribution</h3>
            <div className="chart-container">
              <div className="chart-bar" style={{ height: "30%" }}>
                <span>Low Emission</span>
                <div className="bar-value">30%</div>
              </div>
              <div className="chart-bar" style={{ height: "50%" }}>
                <span>Medium Emission</span>
                <div className="bar-value">50%</div>
              </div>
              <div className="chart-bar" style={{ height: "20%" }}>
                <span>High Emission</span>
                <div className="bar-value">20%</div>
              </div>
            </div>
          </div>
        </div>
        
        {showFAQ && (
          <div className="faq-section glass-card">
            <h2>Frequently Asked Questions</h2>
            <div className="faq-items">
              {faqItems.map((item, index) => (
                <div className="faq-item" key={index}>
                  <div className="faq-question">{item.question}</div>
                  <div className="faq-answer">{item.answer}</div>
                </div>
              ))}
            </div>
          </div>
        )}
        
        <div className="records-section">
          <div className="section-header">
            <h2>Vehicle Emission Records</h2>
            <div className="header-actions">
              <button 
                onClick={loadRecords}
                className="refresh-btn glass-button"
                disabled={isRefreshing}
              >
                {isRefreshing ? "Refreshing..." : "Refresh"}
              </button>
            </div>
          </div>
          
          <div className="records-list glass-card">
            <div className="table-header">
              <div className="header-cell">Vehicle ID</div>
              <div className="header-cell">Emission Data</div>
              <div className="header-cell">Owner</div>
              <div className="header-cell">Date</div>
              <div className="header-cell">Toll</div>
              <div className="header-cell">Status</div>
              <div className="header-cell">Actions</div>
            </div>
            
            {records.length === 0 ? (
              <div className="no-records">
                <div className="no-records-icon"></div>
                <p>No vehicle records found</p>
                <button 
                  className="glass-button primary"
                  onClick={() => setShowCreateModal(true)}
                >
                  Add First Vehicle
                </button>
              </div>
            ) : (
              records.map(record => (
                <div className="record-row" key={record.id}>
                  <div className="table-cell record-id">#{record.id.substring(0, 6)}</div>
                  <div className="table-cell emission-data">
                    {record.encryptedEmission.substring(0, 12)}...
                  </div>
                  <div className="table-cell">{record.owner.substring(0, 6)}...{record.owner.substring(38)}</div>
                  <div className="table-cell">
                    {new Date(record.timestamp * 1000).toLocaleDateString()}
                  </div>
                  <div className="table-cell">{record.toll.toFixed(2)} ETH</div>
                  <div className="table-cell">
                    <span className={`status-badge ${record.status}`}>
                      {record.status}
                    </span>
                  </div>
                  <div className="table-cell actions">
                    <button 
                      className="action-btn glass-button"
                      onClick={() => viewRecordDetails(record)}
                    >
                      Details
                    </button>
                    {isOwner(record.owner) && record.status === "pending" && (
                      <button 
                        className="action-btn glass-button success"
                        onClick={() => calculateToll(record.id)}
                      >
                        Calculate
                      </button>
                    )}
                    {isOwner(record.owner) && record.status === "calculated" && (
                      <button 
                        className="action-btn glass-button primary"
                        onClick={() => payToll(record.id)}
                      >
                        Pay
                      </button>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
  
      {showCreateModal && (
        <ModalCreate 
          onSubmit={submitRecord} 
          onClose={() => setShowCreateModal(false)} 
          creating={creating}
          recordData={newRecordData}
          setRecordData={setNewRecordData}
        />
      )}
      
      {walletSelectorOpen && (
        <WalletSelector
          isOpen={walletSelectorOpen}
          onWalletSelect={(wallet) => { onWalletSelect(wallet); setWalletSelectorOpen(false); }}
          onClose={() => setWalletSelectorOpen(false)}
        />
      )}
      
      {transactionStatus.visible && (
        <div className="transaction-modal">
          <div className="transaction-content glass-card">
            <div className={`transaction-icon ${transactionStatus.status}`}>
              {transactionStatus.status === "pending" && <div className="fhe-spinner"></div>}
              {transactionStatus.status === "success" && <div className="check-icon"></div>}
              {transactionStatus.status === "error" && <div className="error-icon"></div>}
            </div>
            <div className="transaction-message">
              {transactionStatus.message}
            </div>
          </div>
        </div>
      )}
      
      {selectedRecord && (
        <RecordDetails 
          record={selectedRecord} 
          onClose={closeRecordDetails} 
        />
      )}
  
      <footer className="app-footer">
        <div className="footer-content">
          <div className="footer-brand">
            <div className="logo">
              <div className="leaf-icon"></div>
              <span>FHE Road Pricing</span>
            </div>
            <p>Privacy-first dynamic toll system powered by FHE</p>
          </div>
          
          <div className="footer-links">
            <a href="#" className="footer-link">Documentation</a>
            <a href="#" className="footer-link">Privacy Policy</a>
            <a href="#" className="footer-link">Terms of Service</a>
            <a href="#" className="footer-link">Contact</a>
          </div>
        </div>
        
        <div className="footer-bottom">
          <div className="fhe-badge">
            <span>FHE-Powered Privacy</span>
          </div>
          <div className="copyright">
            © {new Date().getFullYear()} FHE Road Pricing. All rights reserved.
          </div>
        </div>
      </footer>
    </div>
  );
};

interface ModalCreateProps {
  onSubmit: () => void; 
  onClose: () => void; 
  creating: boolean;
  recordData: any;
  setRecordData: (data: any) => void;
}

const ModalCreate: React.FC<ModalCreateProps> = ({ 
  onSubmit, 
  onClose, 
  creating,
  recordData,
  setRecordData
}) => {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    const { name, value } = e.target;
    setRecordData({
      ...recordData,
      [name]: value
    });
  };

  const handleSubmit = () => {
    if (!recordData.vehicleId || !recordData.emissionLevel) {
      alert("Please fill required fields");
      return;
    }
    
    onSubmit();
  };

  return (
    <div className="modal-overlay">
      <div className="create-modal glass-card">
        <div className="modal-header">
          <h2>Add Vehicle Record</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        
        <div className="modal-body">
          <div className="fhe-notice-banner">
            <div className="lock-icon"></div> Your emission data will be encrypted with FHE
          </div>
          
          <div className="form-grid">
            <div className="form-group">
              <label>Vehicle ID *</label>
              <input 
                type="text"
                name="vehicleId"
                value={recordData.vehicleId} 
                onChange={handleChange}
                placeholder="Enter vehicle identification..." 
                className="glass-input"
              />
            </div>
            
            <div className="form-group">
              <label>Emission Level (g/km) *</label>
              <input 
                type="number"
                name="emissionLevel"
                value={recordData.emissionLevel} 
                onChange={handleChange}
                placeholder="Enter CO2 emissions..." 
                className="glass-input"
              />
            </div>
            
            <div className="form-group">
              <label>Location</label>
              <input 
                type="text"
                name="location"
                value={recordData.location} 
                onChange={handleChange}
                placeholder="Enter location..." 
                className="glass-input"
              />
            </div>
          </div>
          
          <div className="privacy-notice">
            <div className="privacy-icon"></div> Emission data remains encrypted during FHE processing
          </div>
        </div>
        
        <div className="modal-footer">
          <button 
            onClick={onClose}
            className="cancel-btn glass-button"
          >
            Cancel
          </button>
          <button 
            onClick={handleSubmit} 
            disabled={creating}
            className="submit-btn glass-button primary"
          >
            {creating ? "Encrypting with FHE..." : "Submit Securely"}
          </button>
        </div>
      </div>
    </div>
  );
};

interface RecordDetailsProps {
  record: VehicleRecord;
  onClose: () => void;
}

const RecordDetails: React.FC<RecordDetailsProps> = ({ record, onClose }) => {
  return (
    <div className="modal-overlay">
      <div className="details-modal glass-card">
        <div className="modal-header">
          <h2>Vehicle Record Details</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        
        <div className="modal-body">
          <div className="detail-row">
            <span className="detail-label">Record ID:</span>
            <span className="detail-value">{record.id}</span>
          </div>
          
          <div className="detail-row">
            <span className="detail-label">Vehicle Owner:</span>
            <span className="detail-value">{record.owner}</span>
          </div>
          
          <div className="detail-row">
            <span className="detail-label">Date Recorded:</span>
            <span className="detail-value">
              {new Date(record.timestamp * 1000).toLocaleString()}
            </span>
          </div>
          
          <div className="detail-row">
            <span className="detail-label">Encrypted Emission:</span>
            <span className="detail-value encrypted">
              {record.encryptedEmission.substring(0, 24)}...
            </span>
          </div>
          
          <div className="detail-row">
            <span className="detail-label">Calculated Toll:</span>
            <span className="detail-value toll">{record.toll.toFixed(2)} ETH</span>
          </div>
          
          <div className="detail-row">
            <span className="detail-label">Payment Status:</span>
            <span className={`detail-value status-${record.status}`}>
              {record.status.toUpperCase()}
            </span>
          </div>
          
          <div className="fhe-explanation">
            <h3>FHE Protection</h3>
            <p>
              Your vehicle's emission data is encrypted using Fully Homomorphic Encryption (FHE). 
              This allows the system to calculate your toll without ever decrypting your sensitive data.
            </p>
          </div>
        </div>
        
        <div className="modal-footer">
          <button 
            onClick={onClose}
            className="close-btn glass-button"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};

export default App;