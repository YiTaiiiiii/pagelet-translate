import { createRoot } from 'react-dom/client';
import { Settings } from '../../ui/Settings';
import { extensionBridge } from '../../ui/bridge';
import '../../ui/global.css';
createRoot(document.getElementById('root')!).render(<Settings bridge={extensionBridge} />);
