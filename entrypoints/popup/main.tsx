import { createRoot } from 'react-dom/client';
import { Popup } from '../../ui/Popup';
import { extensionBridge } from '../../ui/bridge';
import '../../ui/global.css';
document.body.classList.add('popup-body');
createRoot(document.getElementById('root')!).render(<Popup bridge={extensionBridge} />);
